import type { McpServer } from '@modelcontextprotocol/server';
import { gather } from '../core/gather.ts';
import { logger } from '../core/logger.ts';
import { hasArtistMonitor } from '../services/types.ts';
import type { ArtistMonitorCapable, ArtistMonitorPolicy, ServiceAdapter } from '../services/types.ts';
import type { ToolContext } from '../tools/register.ts';
import { buildGetLibrary } from '../tools/getLibrary.ts';
import { buildStackHealth } from '../tools/stackHealth.ts';
import { WRITE_TOOLS } from '../tools/register.ts';
import { TOOL_DOC_ALIASES, TOOL_DOCS } from './toolDocs.ts';
import { toolUsable, type SurfaceOptions } from './toolSurface.ts';

/**
 * The four resources (0.9 spec ).
 *
 * **Every one mirrors a tool.** That is the rule the whole phase rests on:
 * client support for resources is uneven, and arr-mcp has to work on all of
 * them, so a resource exposing something no tool returns would be unreachable
 * wherever they are not surfaced. Nothing here originates — `arr://instances`
 * is `get_stack_health`'s services and permissions, `arr://health` is
 * `get_stack_health`, the summary is `get_library` aggregates, and the Lidarr
 * policy is the distribution `update_media` reports in its preview.
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

/** Five minutes, same reasoning as the summary: a stale policy is still the
 *  policy someone set, and this is read to ask "is this stable", not "what is
 *  happening right now". */
const MONITORING_TTL_MS = 5 * 60 * 1000;

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

/** Every Lidarr adapter that can answer for artist policies, in id order.
 *
 * Both branches below ask whether Lidarr can explain music, not merely whether
 * a `lidarr` entry exists: an adapter that cannot list artist policies has no
 * music rows to account for and no policy to report. Keeping one predicate
 * stops the summary and the monitoring resource disagreeing about what
 * "configured" means.
 *
 * A list, because Lidarr can be configured more than once. Taking the first
 * would report one instance's policy as if it were the whole music library's.
 */
const lidarrsWithPolicies = (adapters: readonly ServiceAdapter[]): (ServiceAdapter & ArtistMonitorCapable)[] =>
    adapters.filter((a): a is ServiceAdapter & ArtistMonitorCapable => hasArtistMonitor(a));

/** The counts the monitoring resource reports, for one instance or for all of them. */
const policyCounts = (policies: readonly ArtistMonitorPolicy[]) => {
    const byPolicy: Record<string, number> = {};
    let flagged = 0;
    for (const p of policies) {
        byPolicy[p.monitorNewItems] = (byPolicy[p.monitorNewItems] ?? 0) + 1;
        if (p.monitored) flagged += 1;
    }

    // `unknown` counts against stability on purpose. A policy that could not
    // be read is not a policy that is off, and calling it settled is the
    // confidently-wrong answer this file keeps refusing to give.
    const autoMonitoring = (byPolicy['all'] ?? 0) + (byPolicy['new'] ?? 0) + (byPolicy['unknown'] ?? 0);

    return {
        counts: {
            artists: policies.length,
            monitor_new_items: byPolicy,
            artist_flag: { monitored: flagged, unmonitored: policies.length - flagged },
            // An empty artist list is stable in the only sense this field
            // reports: nothing in it can grow the wanted list by itself.
            // `false` beside a note saying nothing will grow was the one pair
            // a reader could not reconcile.
            stable: policies.length === 0 || autoMonitoring === 0
        },
        autoMonitoring
    };
};

export function registerAllResources(server: McpServer, context: ToolContext, surface?: SurfaceOptions): void {
    const { adapters, instances, library } = context;

    server.registerResource(
        'instances',
        'arr://instances',
        {
            title: 'Configured instances',
            description:
                'Every configured service instance: its id, its type, and what it is permitted to do. The ids here are exactly the values other tools accept as `instance`. Mirrors get_stack_health, which answers the same thing for a client that does not surface resources.',
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
                'A point-in-time verdict per service. **`get_stack_health` is the live answer** — this is a snapshot and says in `as_of` when it was taken. Read it again rather than trusting a pinned copy: a service that was reachable an hour ago may not be now.',
            mimeType: 'application/json',
            cacheHint: { ttlMs: HEALTH_TTL_MS, cacheScope: 'private' }
        },
        async uri => {
            // Caught like `library-summary`'s: a resource read that throws is a
            // client-visible error, and "health could not be taken" is itself
            // health information. buildStackHealth degrades internally today,
            // so this is defence in depth rather than a live path.
            try {
                const health = await buildStackHealth(adapters, { detail: 'standard', limit: 50 }, instances);
                return json(uri, {
                    services: health.services,
                    failures: health.failures.items,
                    degraded: health.degraded
                });
            } catch (err) {
                logger.warn({ err }, 'stack health snapshot failed; reporting it as unavailable');
                return json(uri, {
                    services: [],
                    failures: [],
                    degraded: [],
                    note: 'The health snapshot could not be taken. Call get_stack_health for the live answer.'
                });
            }
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

                const monitored = await buildGetLibrary(library, { detail: 'minimal', limit: 1, monitored: true });

                // `limit: 1` throughout: only the totals are wanted, and this
                // reads from the same cached snapshot get_library does, so the
                // four calls cost one library read rather than four.
                //
                // `total` on its own was the trap. Lidarr imports an artist's
                // whole discography as album rows and monitors only some of them,
                // so a finished music library reports tens of thousands of
                // "library" items that are neither on disk nor wanted and never
                // will be. Read as a library size that is a number no owner would
                // recognise as theirs, so `monitored` sits beside it and the note
                // says which of the two is the library.
                //
                // The Lidarr sentence is conditional. Unmonitored rows with no
                // Lidarr configured came from somewhere else, and naming Lidarr
                // as the usual source would send the reader to a service they do
                // not run.
                const unmonitored = all.total - monitored.total;
                const lidarrConfigured = lidarrsWithPolicies(adapters).length > 0;
                return json(uri, {
                    total: all.total,
                    monitored: monitored.total,
                    unmonitored,
                    on_disk: onDisk.total,
                    wanted: wanted.total,
                    degraded: all.degraded,
                    ...(all.total === monitored.total
                        ? {}
                        : {
                              note:
                                  `total counts every row the services hold, and ${unmonitored} of them are unmonitored: ` +
                                  'nothing is pending on those and nothing will be. ' +
                                  (lidarrConfigured
                                      ? 'Lidarr is the usual source — it imports '
                                          + "an artist's whole discography as catalog and monitors only part of it. "
                                      : '') +
                                  '`monitored` is what the services are actually watching.'
                          })
                });
            } catch (err) {
                // A resource read that throws is a client-visible error for
                // something nobody explicitly asked for. Degrading matches how
                // every list tool here behaves when a service is down.
                logger.warn({ err }, 'library summary resource degraded');
                return json(uri, {
                    total: 0,
                    monitored: 0,
                    unmonitored: 0,
                    on_disk: 0,
                    wanted: 0,
                    degraded: ['library']
                });
            }
        }
    );

    /**
     * Lidarr's monitoring policy, readable without a write.
     *
     * This mirrors `update_media`, which reports the same distribution in its
     * preview, so it originates nothing — the rule every resource here rests on.
     * It exists because before it the only way to ask "is my music library
     * stable" was to invoke a write tool in dry run: an odd thing to have to do
     * to read a number, and impossible for a read-only credential.
     *
     * The album level is deliberately not folded in. An album's flag and its
     * artist's flag are independent — a live library was found with an artist
     * unmonitored while an album under it stayed monitored — so no single view
     * settles both, and pretending otherwise here would repeat the mistake this
     * resource exists to make visible.
     */
    server.registerResource(
        'lidarr-monitoring',
        'arr://lidarr/monitoring',
        {
            title: 'Lidarr monitoring policy',
            description:
                "Every Lidarr artist's monitoring policy in one read: how many will monitor albums they discover later, and how many carry the artist-level monitor flag. `update_media` with no `id` (and `instance` when there is more than one Lidarr) is the live answer and the way to change it. The artist flag is not the album flag — an artist can read unmonitored while an album under it stays monitored — so read arr://library/summary for what is actually pending. With more than one Lidarr, `instances` reports each one that answered (one that did not is listed in `degraded`), since `update_media` writes one instance at a time, and the totals add those instances up: an artist two Lidarrs hold counts once in each.",
            mimeType: 'application/json',
            cacheHint: { ttlMs: MONITORING_TTL_MS, cacheScope: 'private' }
        },
        async uri => {
            const lidarrs = lidarrsWithPolicies(adapters);
            if (lidarrs.length === 0) {
                // Absent, not zero: holding no artists and having no Lidarr at all
                // are different facts, and only one of them is a config problem.
                return json(uri, {
                    configured: false,
                    note:
                        'No Lidarr with artist monitoring is configured, so there is no music monitoring policy to read.'
                });
            }

            // Each instance is read on its own, so one unreachable Lidarr is
            // named as degraded rather than taking the others' answer with it.
            const { items: read, degraded } = await gather<{ service: string; policies: ArtistMonitorPolicy[] }>(
                lidarrs.map(l => ({
                    id: l.id,
                    fetch: async () => [{ service: l.id, policies: await l.listArtistMonitorPolicies() }]
                }))
            );

            const several = lidarrs.length > 1;
            if (read.length === 0) {
                return json(uri, {
                    configured: true,
                    artists: 0,
                    stable: false,
                    ...(several ? { degraded } : {}),
                    note: several
                        ? 'The policies could not be read, which is not the same as them being off. Call update_media ' +
                          'with no `id` and `instance` for the live answer.'
                        : 'The policy could not be read, which is not the same as it being off. Call update_media with ' +
                          'no `id` for the live answer.'
                });
            }

            const { counts: total, autoMonitoring } = policyCounts(read.flatMap(r => r.policies));
            const empty = total.artists === 0;

            // With several Lidarrs, a write names one of them or is refused.
            const change = several ? 'update_media with no `id` and `instance`' : 'update_media with no `id`';
            // The totals add the instances up, so an artist two of them hold is
            // counted in each, unlike get_library's one merged row.
            const counted = several ? ' (counted once per instance)' : '';
            const treadmill =
                `${autoMonitoring} artist(s)${counted} will keep monitoring albums they discover later, or report no ` +
                'readable policy. Unmonitoring albums under those artists is a treadmill until the policy ' +
                `changes — ${change} does it.`;
            let note: string;
            if (degraded.length > 0) {
                // Nothing here may claim the wanted list cannot grow: the
                // instance that did not answer may be the one growing it.
                const policy = degraded.length === 1 ? 'its policy' : 'their policies';
                const unread =
                    `${degraded.join(', ')} could not be read, which is not the same as ${policy} being off, so the ` +
                    'counts cover only the rest and cannot say the wanted list will not grow.';
                note = autoMonitoring > 0 ? `${unread} ${treadmill}` : unread;
            } else if (empty) {
                note = several
                    ? 'None of these Lidarrs holds any artists, so they report no monitoring policy and nothing here ' +
                      'can grow the wanted list by itself. Check that they hold the artists you expect.'
                    : 'This Lidarr holds no artists, so it reports no monitoring policy and nothing here can grow ' +
                      'the wanted list by itself. Check that it holds the artists you expect.';
            } else if (autoMonitoring === 0) {
                note =
                    "No artist will monitor an album it discovers later, so the wanted list cannot grow by itself. " +
                    "The artist-level flag is separate from an album's own: read arr://library/summary for what is " +
                    'still pending.';
            } else {
                note = treadmill;
            }

            return json(uri, {
                configured: true,
                ...total,
                // Stable is a claim about the whole music library, and an
                // instance that did not answer may be the one still growing.
                stable: total.stable && degraded.length === 0,
                // One Lidarr keeps the shape it always had. With several, each
                // is reported as well: `set_monitoring` writes one instance at
                // a time, so the totals alone do not say where to write.
                ...(several
                    ? {
                          instances: read.map(r => ({ service: r.service, ...policyCounts(r.policies).counts })),
                          ...(degraded.length === 0 ? {} : { degraded })
                      }
                    : {}),
                note
            });
        }
    );

    // The field-by-field detail the tool descriptions point at (#518). Static
    // text, so it is listed once and costs nothing until a client reads it.
    // Not for a tool `tools/list` leaves out: a docs resource never outlives its tool.
    const docs: [name: string, tool: string, text: string][] = [
        ...Object.entries(TOOL_DOCS).map(([tool, text]): [string, string, string] => [tool, tool, text]),
        ...Object.entries(TOOL_DOC_ALIASES).map(([old, current]): [string, string, string] => [old, current, TOOL_DOCS[current]!])
    ];
    for (const [name, tool, text] of docs) {
        if (surface !== undefined && !toolUsable(name, surface, WRITE_TOOLS.has(name))) continue;
        server.registerResource(
            `docs-${name}`,
            `arr://docs/${name}`,
            {
                title: `${name} reference`,
                description: name === tool ? `The full field reference for ${name}: every output field and its caveats.` : `Deprecated: use arr://docs/${tool}.`,
                mimeType: 'text/markdown'
            },
            uri => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] })
        );
    }
}
