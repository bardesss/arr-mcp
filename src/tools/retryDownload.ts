import { INSTANCE_PARAM_DESCRIPTION, resolveInstance } from './resolveInstance.ts';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceIdSchema, type ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
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

const findRetryAdapter = (adapters: readonly ServiceAdapter[], service: ServiceId, instance?: string) => {
    const adapter = resolveInstance(adapters, service, instance);
    if (!hasRetry(adapter)) {
        throw new ServiceError('NotFound', service, `${service} cannot retry a download`, {
            remedy: 'retry_download is for sabnzbd and nzbget.'
        });
    }
    return adapter;
};

/** What each method does, in the words a person would use for it. */
const METHOD_TEXT: Record<RetryMethod, (client: string) => string> = {
    unlock: client => `Gives ${client} the password, so the paused encrypted job carries on downloading.`,
    retry: client => `Asks ${client} to retry the failed job: it fetches what is missing, then repairs and unpacks again.`,
    postprocess: client => `Runs ${client}'s post-processing again (repair, unpack and scripts) on the files it already has.`,
    'retry-failed': client => `Asks ${client} to download the missing articles again, then repair and unpack.`
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
    ['whisparr', 'Whisparr'],
    ['lidarr', 'Lidarr']
] as const;

/** The preview's lines about replacements. Whisparr and Lidarr are named
 *  only when one is configured; naming them otherwise is noise. */
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
 *  two-copies warning again, since the model may not pass the preview on. */
function arrLines(view: ArrView): string[] {
    const tracking = view.traces.map(t => t.service);
    const lines =
        tracking.length > 0
            ? [`${tracking.join(' and ')} ${tracking.length === 1 ? 'is' : 'are'} tracking this download.`]
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

export function registerRetryDownload(server: McpServer, context: WriteContext, adapters: readonly ServiceAdapter[]): void {
    // Keyed by the plan object, which the harness hands back to `apply` and
    // `applied`. Not in `args`: those bind the token, and an *arr that came
    // back online between preview and confirm would void it.
    const views = new WeakMap<WritePlan, ArrView>();

    registerWriteTool(server, context, {
        name: 'retry_download',
        title: 'Retry a failed usenet download',
        description:
            'Retries one failed download on SABnzbd or NZBGet, the client that holds the files. It picks what to send from the job itself: a SABnzbd job paused for a password is unlocked, a failed SABnzbd job is retried, an NZBGet download with missing articles fetches them again, and one that only failed to unpack is post-processed again. Give `password` when the failure was an encrypted archive; it comes from the site the NZB came from and is never shown back. Take `id` from the get_history or get_queue row. The preview checks whether Radarr or Sonarr already grabbed a replacement, since retrying then can leave two copies. If no *arr imports the result, trigger_scan with action: "import" does. Safe tier. Previews by default — call again with the returned `confirm` token to apply it.',
        inputSchema: z.object({
            service: ServiceIdSchema.describe('sabnzbd or nzbget.'),
            instance: z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION),
            id: z.string().min(1).describe("the id on that client's get_history or get_queue row"),
            password: z.string().min(1).optional().describe('the archive password, from the site the NZB came from')
        }),
        // The resolved instance id, not the bare type — permissions are
        // granted per instance.
        service: ({ service, instance }) => findRetryAdapter(adapters, service, instance).id,
        operation: 'retry_download',
        tier: 'safe',

        async plan({ service, instance, id, password }): Promise<WritePlan> {
            const adapter = findRetryAdapter(adapters, service, instance);
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

        async apply(plan, { service, instance, id, password }) {
            const adapter = findRetryAdapter(adapters, service, instance);
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
            if (view !== undefined) lines.push(...arrLines(view));
            if (importable(r)) {
                lines.push(`If Radarr or Sonarr does not import it, trigger_scan with action: "import" and download_id: "${r.download_id}" does.`);
            }
            return lines.join(' ');
        }
    });
}
