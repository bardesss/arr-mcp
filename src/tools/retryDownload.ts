import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {
    hasDownloadTrace,
    hasRetry,
    type DownloadTrace,
    type RetryMethod,
    type RetryOutcome,
    type RetryTarget,
    type ServiceAdapter
} from '../services/types.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';
import { targetInput, serviceTarget } from './serviceTarget.ts';

/**
 * "The download failed, try it again" — on the usenet client itself, which is
 * where the files and the failure are. Safe tier: a retry only downloads or
 * unpacks again, and the worst case is a second copy, which the preview warns
 * about when an *arr has already moved on.
 *
 * The preview decides the method and binds it into the token, so a job that
 * changed state in between is refused by the adapter rather than sent a verb
 * the preview never showed. The password rides only in `args.password`, which
 * the audit log scrubs; it never reaches the summary, effects or result.
 */

const TARGET = serviceTarget({
    services: ['sabnzbd', 'nzbget', 'shelfmark'],
    can: hasRetry,
    cannot: 'cannot retry a download'
});

/** What each method does, in the words a person would use for it. */
const METHOD_TEXT: Record<RetryMethod, (client: string) => string> = {
    unlock: client => `Gives ${client} the password, so the paused encrypted job carries on downloading.`,
    retry: client => `Asks ${client} to retry the failed job: it fetches what is missing, then repairs and unpacks again.`,
    postprocess: client => `Runs ${client}'s post-processing again (repair, unpack and scripts) on the files it already has.`,
    'retry-failed': client => `Asks ${client} to download the missing articles again, then repair and unpack.`,
    requeue: client => `Puts it back at the front of ${client}'s queue to download again.`
};

/** What the *arrs said about this download, kept from the plan so the result
 *  can repeat it without asking them a second time. */
type ArrView = {
    traces: DownloadTrace[];
    /** *arrs that could not be asked, so their silence proves nothing. */
    unreachable: string[];
};

/**
 * Whether an *arr recorded this download and whether it already replaced it.
 * Every tracing adapter is asked at once; one that cannot be reached is
 * named, rather than failing the preview or passing for "no replacement".
 */
async function askArrs(adapters: readonly ServiceAdapter[], downloadId: string): Promise<ArrView> {
    const answers = await Promise.all(
        adapters.filter(hasDownloadTrace).map(async adapter => {
            try {
                return { trace: await adapter.traceDownload(downloadId) };
            } catch {
                return { unreachable: adapter.id };
            }
        })
    );
    return {
        traces: answers.flatMap(a => (a.trace === undefined ? [] : [a.trace])),
        unreachable: answers.flatMap(a => (a.unreachable === undefined ? [] : [a.unreachable]))
    };
}

/** The *arrs with no download trace, by adapter type and display name. */
const UNTRACED = [
    ['lidarr', 'Lidarr']
] as const;

/** The preview's lines about replacements. Lidarr is named
 *  only when one is configured; naming it otherwise is noise. */
function movedOnLines(view: ArrView, adapters: readonly ServiceAdapter[]): string[] {
    const replaced = view.traces.flatMap(trace => {
        const next = trace.replacement;
        if (next === undefined) return [];
        return [
            `${trace.service} has already grabbed ${next.title} (${next.grabbedAt}) for the same media, and ${next.imported ? 'imported it' : 'has not imported it yet'}. Retrying this one may leave two copies.`
        ];
    });
    const unreachable = view.unreachable.map(id => `Could not check ${id} for a replacement, so one it grabbed would not show here.`);
    const unchecked = UNTRACED.filter(([type]) => adapters.some(a => a.type === type)).map(([, name]) => name);
    return [
        ...replaced,
        ...unreachable,
        ...(unchecked.length === 0 ? [] : [`${unchecked.join(' and ')} ${unchecked.length === 1 ? 'is' : 'are'} not checked for a replacement.`])
    ];
}

/** The result's lines about the *arrs: who is tracking it, and the
 *  two-copies warning again, since the model may not pass the preview on.
 *  `renewed` is a SABnzbd retry's new nzo_id: the *arr only ever saw the old
 *  one, so it is not tracking the retried job. */
function arrLines(view: ArrView, renewed: boolean): string[] {
    const tracking = view.traces.map(t => t.service);
    const tracked = `${tracking.join(' and ')} ${tracking.length === 1 ? 'is' : 'are'} tracking this download.`;
    const original = `${tracking.join(' and ')} recorded the original grab; the retried job has a new id ${tracking.length === 1 ? 'it does' : 'they do'} not know.`;
    const lines =
        tracking.length > 0
            ? [renewed ? original : tracked]
            : view.unreachable.length > 0
              ? [`No *arr that could be checked recorded this download; could not check ${view.unreachable.join(' or ')}.`]
              : ['No *arr recorded this download, so none will import it on its own.'];
    for (const trace of view.traces) {
        if (trace.replacement !== undefined) {
            lines.push(`${trace.service} had already grabbed ${trace.replacement.title} for the same media, so two copies may now be coming.`);
        }
    }
    return lines;
}

/** Worth importing by hand: still on its way, or finished well. A failure or
 *  a job already gone from the client leaves nothing to import. */
const importable = (outcome: Pick<RetryOutcome, 'state' | 'event'>) =>
    outcome.state === 'downloading' || outcome.state === 'processing' || outcome.event === 'imported';

const describeTarget = (target: RetryTarget, client: string) =>
    `${target.title} is ${target.status} in ${client}'s ${target.where}${target.reason === undefined ? '' : `: ${target.reason}`}.`;

/** Where it ended up, in words. A finished rerun with no event is one an *arr
 *  already took out of the client's history, not a failure. */
const describeOutcome = (outcome: Pick<RetryOutcome, 'state' | 'status' | 'event'>, client: string) => {
    if (outcome.state === 'downloading') return `It is downloading again (${outcome.status}).`;
    if (outcome.state === 'processing') return `It is being processed (${outcome.status}).`;
    if (outcome.event === undefined) {
        return `It ran and is no longer in ${client}'s history; an *arr usually imported it and removed it there.`;
    }
    return `It finished: ${outcome.event} (${outcome.status}).`;
};

const RetryDownloadInput = z.object({
    ...targetInput(TARGET),
    id: z.string().min(1).describe("the id on that client's get_history or get_queue row"),
    password: z.string().min(1).optional().describe('the archive password, from the site the NZB came from')
});

export function registerRetryDownload(server: McpServer, context: WriteContext, adapters: readonly ServiceAdapter[]): void {
    // Keyed by the plan object, which the harness hands back to `apply` and
    // `applied`. Not in `args`: those bind the token, and an *arr that came
    // back online between preview and confirm would void it.
    const views = new WeakMap<WritePlan, ArrView>();

    registerWriteTool(server, context, {
        name: 'retry_download',
        title: 'Retry a failed download',
        description:
            'Retries one failed download on SABnzbd or NZBGet, the client that holds the files, or a failed or cancelled book on Shelfmark, which queues it again if Shelfmark says it can. It picks what to send from the job itself: a SABnzbd job paused for a password is unlocked, a failed SABnzbd job is retried, an NZBGet download with missing articles fetches them again, and one that only failed to unpack is post-processed again. Give `password` when the failure was an encrypted archive; it comes from the site the NZB came from and is never shown back. Take `id` from the get_history or get_queue row. The preview checks whether Radarr or Sonarr already grabbed a replacement, since retrying then can leave two copies. If no *arr imports the result, import_download does. Safe tier. Previews first; confirm to apply it.',
        inputSchema: RetryDownloadInput,
        // The resolved instance id, not the bare type — permissions are
        // granted per instance.
        target: { adapters, to: TARGET },
        operation: 'retry_download',
        tier: 'safe',

        async plan({ service, instance, id, password }, adapter): Promise<WritePlan> {
            const target = await adapter.findRetryTarget(id, { hasPassword: password !== undefined });

            const effects = [METHOD_TEXT[target.method](adapter.id), describeTarget(target, adapter.id)];
            const view = target.downloadId === undefined ? undefined : await askArrs(adapters, target.downloadId);
            if (view !== undefined) effects.push(...movedOnLines(view, adapters));
            if (password !== undefined) effects.push('A password will be used.');
            if (password !== undefined && target.method === 'retry' && adapter.type === 'sabnzbd') {
                effects.push(
                    'If this job was added from a URL, SABnzbd fetches the NZB again and may not keep the password.'
                );
            }
            if (password === undefined && target.method === 'postprocess') {
                effects.push(
                    'No password will be supplied, so if it failed for want of one it needs a password, here or set in NZBGet itself.'
                );
            }

            const plan: WritePlan = {
                target: `${adapter.id}:retry/${target.id}`,
                summary: `Retry ${target.title} on ${adapter.id}.`,
                effects,
                args: {
                    service,
                    id,
                    method: target.method,
                    ...(instance === undefined ? {} : { instance }),
                    ...(password === undefined ? {} : { password })
                }
            };
            if (view !== undefined) views.set(plan, view);
            return plan;
        },

        async apply(plan, { id, password }, adapter) {
            const outcome = await adapter.runRetry(id, {
                method: plan.args?.method as RetryMethod,
                ...(password === undefined ? {} : { password })
            });
            // What an *arr knows the job by: a SABnzbd retry's new nzo_id, or
            // else the id the target carried (NZBGet's `drone`, not its NZBID).
            const downloadId = outcome.id === id ? (outcome.target.downloadId ?? outcome.id) : outcome.id;
            const view = views.get(plan);
            return {
                service: adapter.id,
                id: outcome.id,
                ...(outcome.id === id ? {} : { previous_id: id }),
                download_id: downloadId,
                state: outcome.state,
                status: outcome.status,
                ...(outcome.event === undefined ? {} : { event: outcome.event }),
                ...(view === undefined ? {} : { tracked_by: view.traces.map(t => t.service) })
            };
        },

        applied(result, plan) {
            const r = result as Pick<RetryOutcome, 'id' | 'state' | 'status' | 'event'> & {
                service: string;
                previous_id?: string;
                download_id: string;
            };
            const view = views.get(plan);
            const lines = [`Applied. ${plan.summary}`];
            if (r.previous_id !== undefined) lines.push(`Its id is now ${r.id}.`);
            lines.push(describeOutcome(r, r.service));
            if (view !== undefined) lines.push(...arrLines(view, r.previous_id !== undefined));
            // No view means no *arr knows this download's id, as on Shelfmark, so no import to offer.
            if (view !== undefined && importable(r)) {
                lines.push(`If Radarr, Sonarr or Lidarr does not import it, import_download with download_id: "${r.download_id}" does.`);
            }
            return lines.join(' ');
        }
    });
}
