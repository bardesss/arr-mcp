import { INSTANCE_PARAM_DESCRIPTION, resolveInstance } from './resolveInstance.ts';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceIdSchema, type ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import {
    hasDownloadTrace,
    hasRetry,
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

/**
 * Whether an *arr already replaced this download. Every tracing adapter is
 * asked at once; one that cannot be reached says so, rather than failing the
 * preview or passing for "no replacement".
 */
async function movedOn(adapters: readonly ServiceAdapter[], downloadId: string): Promise<string[]> {
    const traced = adapters.filter(hasDownloadTrace);
    const lines = await Promise.all(
        traced.map(async adapter => {
            try {
                const trace = await adapter.traceDownload(downloadId);
                const next = trace?.replacement;
                if (trace === undefined || next === undefined) return undefined;
                return `${trace.service} has already grabbed ${next.title} (${next.grabbedAt}) for the same media, and ${next.imported ? 'imported it' : 'has not imported it yet'}. Retrying this one may leave two copies.`;
            } catch {
                return `Could not check ${adapter.id} for a replacement, so one it grabbed would not show here.`;
            }
        })
    );
    return [
        ...lines.filter((line): line is string => line !== undefined),
        'Whisparr and Lidarr are not checked for a replacement.'
    ];
}

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
            if (target.downloadId !== undefined) effects.push(...(await movedOn(adapters, target.downloadId)));
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

            return {
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
        },

        async apply(plan, { service, instance, id, password }) {
            const adapter = findRetryAdapter(adapters, service, instance);
            const outcome = await adapter.runRetry(id, {
                method: plan.args?.method as RetryMethod,
                ...(password === undefined ? {} : { password })
            });
            return {
                service: adapter.id,
                id: outcome.id,
                ...(outcome.id === id ? {} : { previous_id: id }),
                state: outcome.state,
                status: outcome.status,
                ...(outcome.event === undefined ? {} : { event: outcome.event })
            };
        },

        applied(result, plan) {
            const r = result as Pick<RetryOutcome, 'id' | 'state' | 'status' | 'event'> & {
                service: string;
                previous_id?: string;
            };
            const renamed = r.previous_id === undefined ? '' : ` Its id is now ${r.id}.`;
            return (
                `Applied. ${plan.summary}${renamed} ${describeOutcome(r, r.service)} ` +
                `If Radarr or Sonarr does not import it, trigger_scan with action: "import" and download_id: "${r.id}" does.`
            );
        }
    });
}
