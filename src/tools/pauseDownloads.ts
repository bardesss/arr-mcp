import { createHash } from 'node:crypto';
import { resolveInstance } from './resolveInstance.ts';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { DOWNLOAD_CLIENTS, type ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import { hasPause, hasSpeedLimit, NZBGET_POST_HOLDS, SAB_WAIT_SWITCH, sabWaits, schedulerHolds, type PauseState, type ServiceAdapter, type SpeedLimit } from '../services/types.ts';
import { schedulerLimitRefusal, schedulerPauseRefusal, schedulerResumeRefusal } from '../services/deluge.ts';
import { turtleModeRefusal } from '../services/transmission.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';
import { targetInput, serviceTarget } from './serviceTarget.ts';

/**
 * "Stop downloading, I need the bandwidth", and its inverse, which is the
 * whole reason this is `safe` tier: the undo is the same tool with the other
 * action.
 *
 * `service` is **required**, one client per call, rather than defaulting to
 * every configured client. `registerWriteTool` resolves exactly one service id
 * from the arguments and checks that service's permissions, and a tool
 * spanning three clients would have to name one of them there, which is the
 * failure `write.ts` calls out by name: it would check SABnzbd's writes
 * against Transmission's `permissions` block, so enabling one client would
 * quietly enable another. Naming the client is a small cost; checking the
 * wrong permission is not.
 */

const TARGET = serviceTarget({
    services: DOWNLOAD_CLIENTS,
    can: hasPause,
    cannot: 'cannot be paused',
    hint: 'The *arrs have no pause. They keep grabbing, and the grabs queue up in whichever client is configured.'
});

/** A speed cap is its own capability: a client can pause without having one,
 *  and reporting a limit that was never applied is worse than refusing. */
const findLimitAdapter = (adapters: readonly ServiceAdapter[], service: ServiceId, instance?: string) => {
    const adapter = resolveInstance(adapters, service, instance);
    if (!hasSpeedLimit(adapter)) {
        throw new ServiceError('NotFound', service, `${service} has no download speed limit to set`, {
            remedy: 'Only the download clients throttle: sabnzbd, nzbget, transmission, qbittorrent and deluge.'
        });
    }
    return adapter;
};

const PauseDownloadsInput = z.object({
    ...targetInput(TARGET),
    action: z
        .enum(['pause', 'resume', 'limit'])
        .describe('pause, resume, or limit to cap the download speed without stopping anything.'),
    speed_limit_kbps: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
            'With action: "limit", the download cap in KiB/s; 0 removes the cap. Client-wide, never per item. Required for "limit" and ignored otherwise.'
        ),
    id: z
        .string()
        .min(1)
        .optional()
        .describe(
            'One queue item to pause or resume, exactly as get_queue reported its id. Omit for the whole client. Refused with action "limit".'
        )
});

/**
 * What else holds one SABnzbd, NZBGet or Deluge item, for its resume preview
 * and for the no-op of an item not paused itself: its client's paused queue,
 * which this tool resumes without an `id`; SABnzbd's wait for
 * post-processing, which ends by itself, though a manual pause can read like
 * it (`sabWaiting`, `#waitOn`); or an hour Deluge's Scheduler marks Paused,
 * whose resume this tool refuses (`schedulerResumeRefusal`).
 */
const HOLD_TEXT: Readonly<Record<NonNullable<PauseState['heldBy']>, (client: string) => { noop: string; effect: string }>> = {
    queue: client => ({
        noop: `${client}'s whole queue is: resume that with this tool and no \`id\`.`,
        effect: `${client}'s whole queue is paused too, so it starts only once that is resumed, with this tool and no \`id\`.`
    }),
    postProcessing: client => ({
        noop: `${sabWaits(client)}, and resumes by itself; if it stays paused, resume it with this tool and no \`id\`.`,
        effect: `${sabWaits(client)}, so it starts downloading once that ends; if the queue stays paused, resume it with this tool and no \`id\`.`
    }),
    scheduler: client => ({
        noop: `${schedulerHolds(client)}.`,
        effect: `${schedulerHolds(client)}, so it starts only then.`
    })
};

/**
 * SABnzbd's whole queue while it reads as waiting for post-processing, from
 * its rows or from its switch and history (`sabWaiting`, `#waitOn`), worded as
 * how it reads, since a manual pause can lie behind the wait. A pause is sent,
 * so the queue stays paused once the wait ends, unless a Queued row shows it
 * paused by hand already; a resume is sent too, though it does not end the
 * wait.
 */
const WAIT_TEXT = {
    pause: (scope: string, client: string) =>
        `Pauses ${scope} on ${client} by hand. ${client} reads as waiting on post-processing (${SAB_WAIT_SWITCH}), after which it would resume by itself; this keeps it paused after.`,
    resume: (client: string) =>
        `If ${client} is waiting on post-processing (${SAB_WAIT_SWITCH}), this does not end that, and downloading starts once it ends.`
};

/** What a new limit also does to Deluge's session, as its Scheduler applies the hour again (`SpeedLimit.sessionChange`). */
const SESSION_CHANGE: Readonly<Record<NonNullable<SpeedLimit['sessionChange']>, (client: string) => string>> = {
    resume: client =>
        `Also resumes ${client}'s paused session, which undoing the limit does not pause again: its Scheduler plugin applies this hour's Normal state again whenever the limit changes.`,
    pause: client =>
        `Also pauses ${client}'s session, which undoing the limit does not resume: its Scheduler plugin applies this hour's Paused state again whenever the limit changes.`
};

/** The first line of a resume preview: what restarts, and what still holds it or may stop it again. */
function resumeLine(state: PauseState, client: string, waiting: boolean): string {
    if (waiting) return `Restarts ${state.scope} on ${client} if it is paused by hand. ${WAIT_TEXT.resume(client)}`;
    // The client's note on what a resume leaves (`resumeNote`) and what else
    // holds the item, both when both apply. With a note the line opens
    // "Resumes", naming the call, since the note says what restarts.
    const notes = [state.resumeNote, state.heldBy === undefined ? undefined : HOLD_TEXT[state.heldBy](client).effect].filter((s): s is string => s !== undefined);
    return `${state.resumeNote === undefined ? 'Restarts' : 'Resumes'} ${state.scope} on ${client}. ${notes.length === 0 ? 'Downloading resumes immediately and uses bandwidth.' : notes.join(' ')}`;
}

/** The exact torrents a whole-client plan read, for its apply. Kept off `args`,
 *  which the digest stands in for, and keyed by the plan the confirm call
 *  verified the token against, so apply acts on what was previewed and not on
 *  a second read. */
const boundTorrents = new WeakMap<WritePlan, readonly string[]>();

const torrentCount = (n: number): string => (n === 1 ? '1 torrent' : `${n} torrents`);

/** The torrents a whole-client pause or resume acts on, folded into its token:
 *  one an *arr sends between preview and confirm voids it, and the fresh
 *  preview names it, rather than the confirm stopping it unannounced. A digest
 *  keeps the audit row short on a client with hundreds. */
const setOf = (ids: readonly string[]): string =>
    createHash('sha256')
        .update([...ids].sort().join('\n'))
        .digest('hex')
        .slice(0, 16);

/**
 * A whole-client pause on a torrent client, which has no client-wide flag:
 * pause stops and marks the running torrents, resume starts the marked ones.
 * So each is a no-op on its own count, not on one shared "paused" reading:
 * a torrent an *arr sent after a pause is running, and a second pause stops it.
 */
function torrentPlan(
    client: string,
    target: string,
    paused: boolean,
    t: NonNullable<PauseState['torrents']>
): WritePlan {
    const ids = paused ? t.runningIds : t.markedIds;
    const args = { action: paused ? 'pause' : 'resume', torrents: setOf(ids) };
    const bind = (plan: WritePlan): WritePlan => {
        boundTorrents.set(plan, ids);
        return plan;
    };
    if (paused) {
        if (t.running === 0) {
            return {
                target,
                summary: t.marked > 0 ? `${client} is already paused: no torrent is running.` : `No torrent is running on ${client}, so there is nothing to pause.`,
                effects: [],
                noop: true
            };
        }
        return bind({
            target,
            summary: `Pause the ${torrentCount(t.running)} running on ${client}.`,
            effects: [
                `Stops them and gives them the ${t.mark}. Nothing already downloaded is lost${t.stopped > 0 ? `, and the ${t.stopped} already stopped stay as they are` : ''}.`,
                'Does NOT stop the *arrs searching and grabbing. A torrent they send meanwhile starts downloading at once.',
                'Undo it by calling this tool again with action: "resume", which starts only the torrents this stopped.'
            ],
            args
        });
    }
    if (t.marked === 0) {
        return {
            target,
            summary: `No torrent on ${client} has the ${t.mark} a pause sets, so there is nothing to resume. Resume a stopped torrent by its \`id\`.`,
            effects: [],
            noop: true
        };
    }
    return bind({
        target,
        summary: `Resume the ${torrentCount(t.marked)} paused on ${client}.`,
        effects: [
            `Starts the ${torrentCount(t.marked)} with the ${t.mark} and removes it; torrents stopped another way stay stopped. Downloading resumes immediately and uses bandwidth.`
        ],
        args
    });
}

export function registerPauseDownloads(
    server: McpServer,
    context: WriteContext,
    adapters: readonly ServiceAdapter[]
): void {
    registerWriteTool(server, context, {
        name: 'pause_downloads',
        title: 'Pause, resume or throttle a download client',
        description:
            'Pauses, resumes or throttles one download client ({{or: sabnzbd=SABnzbd; nzbget=NZBGet; transmission=Transmission; qbittorrent=qBittorrent; deluge=Deluge}}) or one item in its queue when `id` is given. The bandwidth answer: "stop downloading for an hour", or `action: "limit"` with `speed_limit_kbps` (KiB/s) to slow it down instead (0 removes the cap). A limit is client-wide. Safe tier: the undo is the other action. [[transmission|qbittorrent: On {{or: transmission=Transmission; qbittorrent=qBittorrent}}, pause tags the running torrents and resume starts only those.]] It does NOT stop the *arrs grabbing: releases still reach the client. `service` is required and names one client; pausing "everything" means one call each. Previews first; confirm to apply it.',
        inputSchema: PauseDownloadsInput,
        // The resolved instance id, not the bare type: permissions are
        // granted per instance.
        target: { adapters, to: TARGET },
        operation: 'pause_downloads',
        tier: 'safe',

        async plan({ service, instance, action, id, speed_limit_kbps }, adapter): Promise<WritePlan> {
            if (action === 'limit') {
                if (id !== undefined) {
                    throw new Error(
                        '`id` cannot be used with action "limit": a limit is always client-wide. Drop `id`, or use action "pause" to pause that one item.'
                    );
                }
                if (speed_limit_kbps === undefined) {
                    throw new Error('limit needs `speed_limit_kbps`, the cap in KiB/s, or 0 to remove it.');
                }

                const client = findLimitAdapter(adapters, service, instance);
                const current = await client.readSpeedLimit();
                const wanted = speed_limit_kbps === 0 ? undefined : speed_limit_kbps;
                const target = `${client.id}:limit`;

                if (current.kbps === wanted) {
                    return {
                        target,
                        summary:
                            wanted === undefined
                                ? `${client.id} already has no download limit.`
                                : `${client.id} is already limited to ${wanted} KiB/s.`,
                        effects: [],
                        noop: true
                    };
                }
                // The adapter refuses this write too; refusing here means no token is issued for it.
                if (current.alternative) throw turtleModeRefusal(client.id, current.kbps);
                if (current.scheduled) throw schedulerLimitRefusal(client.id, current.kbps);

                return {
                    target,
                    summary:
                        wanted === undefined
                            ? `Remove the download limit on ${client.id}.`
                            : `Limit ${client.id} to ${wanted} KiB/s.`,
                    effects: [
                        wanted === undefined
                            ? `${client.id} will download as fast as the line allows${current.kbps === undefined ? '' : `, instead of the current ${current.kbps} KiB/s`}.`
                            : `Caps ${client.id} at ${wanted} KiB/s${current.kbps === undefined ? ', which currently has no limit' : `, from ${current.kbps} KiB/s`}. Client-wide, not per item.`,
                        ...(current.sessionChange === undefined ? [] : [SESSION_CHANGE[current.sessionChange](client.id)]),
                        'Does NOT stop the *arrs grabbing. They keep sending releases; they just arrive more slowly.',
                        'Undo it by calling this tool again with action: "limit" and a different value; 0 removes the cap.'
                    ],
                    args: { action, kbps: speed_limit_kbps }
                };
            }
            const paused = action === 'pause';
            const state = await adapter.readPauseState(id);

            const target = `${adapter.id}:${id ?? 'all'}`;
            const whole = id === undefined;

            // One NZBGet item in post-processing: NZBGet pauses its spare repair files and unpauses the ones a
            // repair asks for (`RequestMorePars`), so a pause or resume here would only fight it.
            if (state.postProcessing !== undefined) {
                const holds = [
                    ...(state.heldBy === 'queue' ? [NZBGET_POST_HOLDS.queue(adapter.id, 'with this tool and no `id`')] : []),
                    ...(state.postProcessing.paused ? [NZBGET_POST_HOLDS.postPaused(adapter.id)] : [])
                ];
                return {
                    target,
                    summary: [
                        `${state.scope} on ${adapter.id} is ${state.postProcessing.stage}. NZBGet pauses its spare repair files and unpauses the ones a repair asks for, so this sends nothing.`,
                        ...holds
                    ].join(' '),
                    effects: [],
                    noop: true
                };
            }
            // A manual pause can lie behind SABnzbd's wait, so a whole-queue resume is sent, not refused.
            const waiting = whole && state.heldBy === 'postProcessing';

            if (id === undefined && state.torrents !== undefined) return torrentPlan(adapter.id, target, paused, state.torrents);

            // Deluge's resume leaves alone a torrent its queue holds back and
            // one at its stop ratio, whether or not it reads as paused.
            if (!paused && state.resumeNoop !== undefined) {
                return { target, summary: `${state.scope} on ${adapter.id} ${state.resumeNoop}`, effects: [], noop: true };
            }

            // A pause while Deluge's Scheduler runs the session this hour, and
            // a resume while it pauses it, are refused even where the session
            // already is as asked, which the Scheduler would undo all the same;
            // the adapter refuses them too.
            if (whole && paused && state.scheduler === 'run') throw schedulerPauseRefusal(adapter.id);
            if (whole && !paused && state.scheduler === 'stop') throw schedulerResumeRefusal(adapter.id);

            // Asking someone to confirm a no-op teaches them to confirm
            // without reading.
            // A queue paused by hand that the wait also holds: a second pause does nothing, a resume ends one of the two.
            if ((!waiting || paused) && state.paused === paused) {
                // A held item that is not paused itself is not running either.
                const held = paused ? undefined : state.heldBy;
                return {
                    target,
                    summary:
                        held === undefined
                            ? `${state.scope} on ${adapter.id} ${paused ? 'is already paused' : 'is already running'}.`
                            : `${state.scope} on ${adapter.id} is not paused itself, but ${HOLD_TEXT[held](adapter.id).noop}`,
                    effects: [],
                    noop: true
                };
            }

            const grabbed = `Anything the *arrs grabbed while it was paused starts downloading ${waiting ? 'with it' : 'too'}.`;
            // One item paused or resumed leaves the rest of the client as it
            // was, so what the *arrs grab meanwhile neither piles up nor starts.
            // While Deluge's Scheduler marks the hour Paused, the session stays
            // paused through a restart, and a resume is refused.
            const stopHour = whole && state.scheduler === 'stop';
            const effects = paused
                ? [
                      waiting
                          ? WAIT_TEXT.pause(state.scope, adapter.id)
                          : `Stops ${state.scope} on ${adapter.id}. Nothing already downloaded is lost, and partial downloads resume where they left off.`,
                      // The thing a bare "paused" would let someone believe.
                      ...(whole ? ['Does NOT stop the *arrs searching and grabbing. They keep sending releases, which pile up in this client until it is resumed.'] : []),
                      ...(stopHour
                          ? [
                                `${adapter.id}'s Scheduler plugin keeps its whole session paused this hour, as its Schedule says, and resumes it the next time the plugin runs in an hour the Schedule marks Normal or Throttled, or once this hour is changed there or the plugin is turned off; a resume is refused while the Schedule marks the hour Paused.`
                            ]
                          : [
                                ...(whole && state.endsOnRestart === true ? [`It lasts only until ${adapter.id}'s daemon restarts, since the daemon does not save it.`] : []),
                                `Undo it by calling this tool again with action: "resume"${whole ? '' : ` and the same \`id\``}.`
                            ])
                  ]
                : [
                      resumeLine(state, adapter.id, waiting),
                      ...(whole ? [grabbed] : [])
                  ];

            return {
                target,
                summary: `${paused ? 'Pause' : 'Resume'} ${state.scope} on ${adapter.id}.`,
                effects,
                args: { action, ...(id === undefined ? {} : { id }) }
            };
        },

        async apply(plan, { service, instance, action, id, speed_limit_kbps }, adapter) {
            if (action === 'limit') {
                const kbps = speed_limit_kbps === undefined || speed_limit_kbps === 0 ? undefined : speed_limit_kbps;
                const client = findLimitAdapter(adapters, service, instance);
                await client.setSpeedLimit(kbps);
                return { limitKbps: kbps ?? null, service: client.id };
            }
            const note = await adapter.setPaused(action === 'pause', id, boundTorrents.get(plan));
            return {
                [action === 'pause' ? 'paused' : 'resumed']: `${adapter.id}:${id ?? 'all'}`,
                ...(typeof note === 'string' ? { note } : {})
            };
        },

        applied(outcome, plan) {
            const note = (outcome as { note?: string } | undefined)?.note;
            return note === undefined ? undefined : `Applied. ${plan.summary} ${note}.`;
        }
    });
}
