import type { McpServer } from '@modelcontextprotocol/server';
import { logger } from '../core/logger.ts';
import type { ToolContext } from '../tools/register.ts';
import { buildGetLibrary } from '../tools/getLibrary.ts';
import { buildStackHealth } from '../tools/stackHealth.ts';

/**
 * The three resources (0.9 spec §2).
 *
 * **Every one mirrors a tool.** That is the rule the whole phase rests on:
 * client support for resources is uneven, and arr-mcp has to work on all of
 * them, so a resource exposing something no tool returns would be unreachable
 * wherever they are not surfaced. Nothing here originates — `arr://instances`
 * is `stack_health`'s services and permissions, `arr://health` is
 * `stack_health`, and the summary is `get_library` aggregates.
 *
 * Not in `src/tools/`, because these are not tools and putting them there
 * would invite the assumption that adding one costs against
 * `CONTRIBUTING.md`'s roughly-40 ceiling. They also change for different
 * reasons: a resource changes when a client needs different context, a tool
 * when a capability does.
 */

/** An hour. Only a config edit can invalidate the instance list. */
const INSTANCES_TTL_MS = 60 * 60 * 1000;

/**
 * Zero, meaning never cache.
 *
 * A pinned health resource saying "sonarr: reachable" five hours after Sonarr
 * fell over is worse than the tool call it replaced — it is confidently wrong
 * rather than merely absent. The dashboard refuses to cache health for exactly
 * this reason, and this is the same decision in the protocol's own vocabulary.
 */
const HEALTH_TTL_MS = 0;

/** Five minutes. Counts drift, but a five-minute-old count misleads nobody. */
const SUMMARY_TTL_MS = 5 * 60 * 1000;

/**
 * Every resource says when it was true.
 *
 * A `cacheHint` is advice a client is free to ignore; a timestamp inside the
 * content cannot be dropped without dropping the content with it. A reader must
 * never have to guess how old a number is, and for `arr://health` that is the
 * difference between a snapshot and a lie.
 */
const stamped = (body: Record<string, unknown>): string =>
    JSON.stringify({ as_of: new Date().toISOString(), ...body }, null, 2);

const json = (uri: URL, body: Record<string, unknown>) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: stamped(body) }]
});

export function registerAllResources(server: McpServer, context: ToolContext): void {
    const { adapters, instances, library } = context;

    server.registerResource(
        'instances',
        'arr://instances',
        {
            title: 'Configured instances',
            description:
                'Every configured service instance: its id, its type, and what it is permitted to do. The ids here are exactly the values other tools accept as `instance`. Mirrors stack_health, which answers the same thing for a client that does not surface resources.',
            mimeType: 'application/json',
            cacheHint: { ttlMs: INSTANCES_TTL_MS, cacheScope: 'private' }
        },
        uri =>
            json(uri, {
                instances: instances.map(i => ({
                    id: i.id,
                    type: i.type,
                    safe_write: i.config.permissions.safe_write,
                    destructive: i.config.permissions.destructive
                }))
            })
    );

    server.registerResource(
        'health',
        'arr://health',
        {
            title: 'Stack health (snapshot)',
            description:
                'A point-in-time verdict per service. **`stack_health` is the live answer** — this is a snapshot and says in `as_of` when it was taken. Read it again rather than trusting a pinned copy: a service that was reachable an hour ago may not be now.',
            mimeType: 'application/json',
            cacheHint: { ttlMs: HEALTH_TTL_MS, cacheScope: 'private' }
        },
        async uri => {
            const health = await buildStackHealth(adapters, { detail: 'standard', limit: 50 }, instances);
            return json(uri, {
                services: health.services,
                failures: health.failures.items,
                degraded: health.degraded
            });
        }
    );

    server.registerResource(
        'library-summary',
        'arr://library/summary',
        {
            title: 'Library summary',
            description:
                'Counts across the joined library — total, on disk, and still wanted. Mirrors what get_library reports; call that for anything beyond the totals.',
            mimeType: 'application/json',
            cacheHint: { ttlMs: SUMMARY_TTL_MS, cacheScope: 'private' }
        },
        async uri => {
            try {
                const all = await buildGetLibrary(library, { detail: 'minimal', limit: 1 });
                const onDisk = await buildGetLibrary(library, { detail: 'minimal', limit: 1, has_file: true });
                const wanted = await buildGetLibrary(library, {
                    detail: 'minimal',
                    limit: 1,
                    has_file: false,
                    monitored: true
                });

                // `limit: 1` throughout: only the totals are wanted, and this
                // reads from the same cached snapshot get_library does, so the
                // three calls cost one library read rather than three.
                return json(uri, {
                    total: all.total,
                    on_disk: onDisk.total,
                    wanted: wanted.total,
                    degraded: all.degraded
                });
            } catch (err) {
                // A resource read that throws is a client-visible error for
                // something nobody explicitly asked for. Degrading matches how
                // every list tool here behaves when a service is down.
                logger.warn({ err }, 'library summary resource degraded');
                return json(uri, { total: 0, on_disk: 0, wanted: 0, degraded: ['library'] });
            }
        }
    );
}
