import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { ServiceInstance } from '../config/instances.ts';
import type { ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import { DetailSchema, LimitSchema, READ_ONLY, TruncationSchema, applyLimit, listText, memoBy, toolInput, type DetailLevel } from '../core/shape.ts';
import {
    hasCleanup,
    hasCleanuparrRemovals,
    hasCommandStatus,
    hasDiskSpace,
    hasHealthChecks,
    hasLogs,
    hasMediaAdd,
    hasScanState,
    type CleanupOverview,
    type CleanuparrRemovals,
    type CommandStatus,
    type ConnectionDiagnosis,
    type DiskSpace,
    type HealthCheck,
    type LogEntry,
    type ScanState,
    type ServiceAdapter
} from '../services/types.ts';
import { buildSeedingRules, type SeedingRules } from './seedingRules.ts';
import { groupDisks, humanBytes } from '../core/disks.ts';

/** How much of one instance's log `logs` was folded from. */
type LogLines = { service: string; read: number; total: number };

type Shaped<T> = { items: T[]; total: number; returned: number; offset: number; truncated: boolean };

type StackHealthResult = {
    services: ConnectionDiagnosis[];
    disks: Shaped<DiskSpace>;
    failures: Shaped<HealthCheck>;
    /**
     * Not run through applyLimit: bounded by the number of configured services,
     * so it can never exceed eight rows. Wrapping a list that cannot truncate
     * in a truncation contract is noise in every response.
     */
    scans: ScanState[];
    /**
     * The searches, scans, refreshes, renames and imports each service is
     * running now, plus any it finished in the last fifteen minutes — the
     * follow-up `trigger_search` and `trigger_scan` never had. Bounded like
     * `scans` and absent at `minimal`: a running command is not a fault.
     */
    commands?: CommandStatus[];
    /** Present only with two media servers: the one tools default to. */
    primaryMediaServer?: string;
    /**
     * What each instance is allowed to do — absent unless the caller supplied
     * the instances, and absent at `minimal`, which answers "is anything
     * broken" and a permission is not a fault.
     *
     * Reported here because `arr://instances` needs it and a resource must
     * mirror a tool rather than originate one: a client that ignores resources
     * must not be the only one unable to answer "what may I do here". The
     * permission *source* is untouched — `permissionSourceFrom` still reads
     * config so an adapter cannot widen its own grants. This reports the gate's
     * answer; it is not a second one.
     */
    permissions?: InstancePermissions[];
    /** Absent unless the caller supplied the instances, and absent at
     *  `minimal` — a URL is not a fault. */
    endpoints?: InstanceEndpoint[];
    /**
     * What each Radarr, Sonarr, Whisparr or Lidarr instance will accept on an
     * add, and a Radarr or Sonarr instance on an update.
     * Only at `detail: "full"`: it is three extra calls per instance, and it
     * answers "what may I choose", not "is anything broken".
     */
    options?: InstanceOptions[];
    /**
     * Torrent client defaults and indexer seed criteria, plus notes where they
     * disagree. Only at `detail: "full"`, and absent when nothing seeds.
     */
    seedingRules?: SeedingRules;
    /**
     * What a cleanup service (Reclaimerr) is set to delete, soonest first, with
     * its rules and whether its deletion task runs. Only at `detail: "full"`.
     */
    cleanup?: CleanupOverview;
    /**
     * When Cleanuparr's Queue Cleaner and Malware Blocker remove a download, and
     * what each removal does. Only at `detail: "full"`, and only with Cleanuparr
     * configured: it answers "why did my download disappear", not "is anything broken".
     */
    cleanuparrRemovals?: CleanuparrRemovals & { service: string };
    /**
     * Recent warnings and errors from each service's own log, identical lines
     * folded, newest first. Only at `detail: "full"`: a health check says what
     * is failing, the log says why, and that is a question about fixing it.
     */
    logs?: Shaped<LogEntry> & { lines: LogLines[] };
    degraded: string[];
};

/**
 * The values `add_media` and `update_media` refuse to guess at. Paths and tag
 * labels are the **fenced** display forms: these are for reading, and the raw
 * path is only ever posted back inside the write tools, which resolve it
 * themselves.
 */
type InstanceOptions = {
    instance: string;
    qualityProfiles: { id: number; name: string }[];
    /**
     * `unmappedFolders` names folders under this root that the instance
     * associates with no item. Reported here because the root folder read
     * already returns it and dropping it hid the only API-visible trace of a
     * mapping the service has lost. It is a fact, not a fault: a hand-dropped
     * folder and a delete that kept its files look identical from here.
     */
    rootFolders: { path: string; freeSpaceBytes?: number; unmappedFolders?: string[] }[];
    tags: string[];
};

type InstancePermissions = { instance: string; safe_write: boolean; destructive: boolean };

/**
 * Where each instance lives — **never how to authenticate to it**. A sibling of
 * `permissions` rather than a field on it, because a base URL is not a
 * permission and `InstancePermissions` would start lying about what it holds.
 *
 * There is deliberately no tool that returns an API key. Everything a tool
 * returns passes through a model's context, so such a tool would publish the
 * key rather than retrieve it. A script needing credentials runs beside the
 * same config and imports `loadConfig`.
 */
type InstanceEndpoint = { instance: string; service: ServiceId; baseUrl: string };

/**
 * A base URL with its userinfo removed.
 *
 * `UrlSchema` accepts `http://user:pass@host:9091` — Transmission and SABnzbd
 * are routinely deployed behind exactly that — and reporting it verbatim would
 * publish a credential into a model's context under a field whose whole
 * documented promise is that this server never returns one. The strip is here,
 * at the single place a URL leaves the process, rather than in the schema: the
 * adapters still need the URL they were configured with in order to connect.
 *
 * The string is returned untouched when it carries no userinfo, because
 * `new URL(...).toString()` normalises — it appends a trailing slash — and a
 * URL nobody wrote is a small lie of its own.
 */
export function withoutCredentials(url: string): string {
    try {
        const parsed = new URL(url);
        if (parsed.username === '' && parsed.password === '') return url;
        parsed.username = '';
        parsed.password = '';
        return parsed.toString();
    } catch {
        // Unreachable through config, which parses every URL at startup. A
        // credential must not survive an unparseable one either, so drop the
        // authority's userinfo textually rather than returning the input.
        return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1');
    }
}

/**
 * minimal — is anything broken? A verdict per service, and counts only.
 * standard — everything except disk paths, the longest strings in the response
 *            and rarely what the question was about.
 * full — everything, paths included.
 */
function project(result: StackHealthResult, detail: DetailLevel): StackHealthResult {
    if (detail === 'full') return result;

    if (detail === 'standard') {
        return {
            ...result,
            disks: {
                ...result.disks,
                items: result.disks.items.map(({ path: _path, ...rest }) => rest)
            }
        };
    }

    return {
        services: result.services.map(s => ({
            ok: s.ok,
            service: s.service,
            latency_ms: s.latency_ms,
            // Kind and detail, but not the remedy: minimal answers "is it
            // broken", and the remedy is for someone about to fix it.
            ...(s.error === undefined ? {} : { error: { kind: s.error.kind, detail: s.error.detail } })
        })),
        disks: { ...result.disks, items: [], returned: 0 },
        failures: { ...result.failures, items: [], returned: 0 },
        scans: result.scans.map(s => ({
            service: s.service,
            ...(s.lastCompleted === undefined ? {} : { lastCompleted: s.lastCompleted })
        })),
        // No permissions and no endpoints: minimal answers "is anything
        // broken", and neither a grant nor a URL is a fault.
        ...(result.primaryMediaServer === undefined ? {} : { primaryMediaServer: result.primaryMediaServer }),
        degraded: result.degraded
    };
}

/**
 * Composes per-service diagnoses into one answer. This tool must work
 * *especially* well when something is broken — a service
 * that is down contributes a diagnosis and a `degraded` entry, never an
 * exception.
 */
export async function buildStackHealth(
    adapters: readonly ServiceAdapter[],
    opts: { detail: DetailLevel; limit: number },
    /** Optional and last, so every existing call site keeps compiling. */
    instances?: readonly ServiceInstance[],
    primaryMediaServer?: string
): Promise<StackHealthResult> {
    const services: ConnectionDiagnosis[] = [];
    const degraded: string[] = [];
    const disks: DiskSpace[] = [];
    const failures: HealthCheck[] = [];
    const scans: ScanState[] = [];
    const commands: CommandStatus[] = [];
    const logs: LogEntry[] = [];
    const logLines: LogLines[] = [];

    const markDegraded = (id: string) => {
        if (!degraded.includes(id)) degraded.push(id);
    };

    await Promise.all(
        adapters.map(async adapter => {
            let diagnosis: ConnectionDiagnosis;
            try {
                diagnosis = await adapter.testConnection();
            } catch (err) {
                // testConnection is contractually non-throwing, but a bug in
                // one adapter must not take down the whole answer.
                logger.error({ service: adapter.id, err }, 'testConnection threw; treating as degraded');
                diagnosis = {
                    ok: false,
                    service: adapter.id,
                    latency_ms: 0,
                    error: {
                        kind: err instanceof ServiceError ? err.kind : 'UpstreamError',
                        detail: err instanceof Error ? err.message : 'unknown error'
                    }
                };
            }

            services.push(diagnosis);
            if (!diagnosis.ok) {
                markDegraded(adapter.id);
                return; // do not hammer a service that just failed its probe
            }

            // A service with neither capability contributes its diagnosis and
            // no rows, rather than being special-cased out of the loop.
            const [diskResult, healthResult, scanResult, commandResult, logResult] = await Promise.allSettled([
                hasDiskSpace(adapter) ? adapter.getDiskSpace() : Promise.resolve([]),
                hasHealthChecks(adapter) ? adapter.getFailedHealthChecks() : Promise.resolve([]),
                hasScanState(adapter) ? adapter.getScanState() : Promise.resolve(undefined),
                // Skipped at `minimal`, which answers "is anything broken" —
                // a running command is not a fault, and this is a call per
                // service that nobody asked for at that level.
                hasCommandStatus(adapter) && opts.detail !== 'minimal'
                    ? adapter.listCommands()
                    : Promise.resolve([]),
                hasLogs(adapter) && opts.detail === 'full' ? adapter.getRecentLogs() : Promise.resolve(undefined)
            ]);

            if (diskResult.status === 'fulfilled') {
                disks.push(...diskResult.value);
            } else {
                logger.warn({ service: adapter.id }, 'diskspace read failed');
                markDegraded(adapter.id);
            }

            if (healthResult.status === 'fulfilled') {
                failures.push(...healthResult.value);
            } else {
                logger.warn({ service: adapter.id }, 'health read failed');
                markDegraded(adapter.id);
            }

            if (scanResult.status === 'fulfilled') {
                if (scanResult.value !== undefined) scans.push(scanResult.value);
            } else {
                logger.warn({ service: adapter.id }, 'scan state read failed');
                markDegraded(adapter.id);
            }

            if (commandResult.status === 'fulfilled') {
                commands.push(...commandResult.value);
            } else {
                logger.warn({ service: adapter.id }, 'command list read failed');
                markDegraded(adapter.id);
            }

            if (logResult.status === 'fulfilled') {
                if (logResult.value !== undefined) {
                    const { entries, read, total } = logResult.value;
                    logs.push(...entries);
                    logLines.push({ service: adapter.id, read, total });
                }
            } else {
                logger.warn({ service: adapter.id }, 'log read failed');
                markDegraded(adapter.id);
            }
        })
    );

    // Settled per instance, never awaited bare: an instance whose profile list
    // is down still has health worth reporting, and this list is the least
    // important thing in the response.
    const options =
        opts.detail !== 'full'
            ? undefined
            : (
                  await Promise.all(
                      adapters.filter(hasMediaAdd).map(async adapter => {
                          try {
                              const [profiles, folders, tags] = await Promise.all([
                                  adapter.listQualityProfiles(),
                                  adapter.listRootFolders(),
                                  adapter.listTags()
                              ]);
                              return [
                                  {
                                      instance: adapter.id,
                                      qualityProfiles: profiles.map(p => ({ id: p.id, name: p.display })),
                                      rootFolders: folders.map(f => ({
                                          path: f.display,
                                          ...(f.freeSpaceBytes === undefined ? {} : { freeSpaceBytes: f.freeSpaceBytes }),
                                          ...(f.unmappedFolders === undefined ? {} : { unmappedFolders: f.unmappedFolders })
                                      })),
                                      tags: tags.map(t => t.display)
                                  }
                              ];
                          } catch (err) {
                              logger.warn({ service: adapter.id, err }, 'add options unavailable; omitting');
                              markDegraded(adapter.id);
                              return [];
                          }
                      })
                  )
              )
                  .flat()
                  .sort((a, b) => a.instance.localeCompare(b.instance));

    const cleanupAdapter = opts.detail === 'full' ? adapters.find(hasCleanup) : undefined;
    const removalSource = opts.detail === 'full' ? adapters.find(hasCleanuparrRemovals) : undefined;
    // Independent reads: none waits on another.
    const [seedingRules, cleanup, cleanuparrRemovals] = await Promise.all([
        opts.detail === 'full' ? buildSeedingRules(adapters, markDegraded) : undefined,
        cleanupAdapter === undefined || degraded.includes(cleanupAdapter.id)
            ? undefined
            : cleanupAdapter.readCleanupOverview(opts.limit).catch((err: unknown) => {
                  logger.warn({ service: cleanupAdapter.id, err }, 'cleanup overview read failed; omitting');
                  markDegraded(cleanupAdapter.id);
                  return undefined;
              }),
        removalSource === undefined
            ? undefined
            : removalSource.getRemovalRules().then(
                  r => ({ service: removalSource.id, ...r }),
                  (err: unknown) => {
                      logger.warn({ service: removalSource.id, err }, 'Cleanuparr removal rules unavailable; omitting');
                      markDegraded(removalSource.id);
                      return undefined;
                  }
              )
    ]);
    const hasSeedingRules =
        seedingRules !== undefined &&
        (seedingRules.clients.length > 0 || seedingRules.indexers.length > 0 || (seedingRules.cleanuparr?.length ?? 0) > 0);

    // Promise.all resolves in input order but the pushes above race, so sort to
    // make the response stable across calls and diffable in tests.
    services.sort((a, b) => a.service.localeCompare(b.service));
    scans.sort((a, b) => a.service.localeCompare(b.service));
    // Newest first across services: "did the thing I just started finish" is
    // a question about the most recent rows.
    commands.sort((a, b) => (b.queuedAt ?? '').localeCompare(a.queuedAt ?? ''));
    // As instants, not strings: the services write their times differently, and
    // Bazarr's have no offset, so those sort as if in this server's zone.
    logs.sort((a, b) => (Date.parse(b.lastSeen) || 0) - (Date.parse(a.lastSeen) || 0));
    logLines.sort((a, b) => a.service.localeCompare(b.service));
    degraded.sort();

    // One budget across both lists, spent on failures first: a failing health
    // check is the reason someone called this tool, and a disk row is context.
    // Applying `limit` to each list independently let `limit: 50` return 100
    // rows, against a parameter whose only job is bounding context.
    const shapedFailures = applyLimit(failures, opts.limit);
    const remaining = Math.max(0, opts.limit - shapedFailures.returned);

    // applyLimit clamps its limit to a minimum of one, deliberately: a caller
    // must not be able to ask for zero items and get a silently empty list.
    // A spent budget is the one case where zero is the honest answer, so it is
    // handled here rather than by weakening that guard for every other caller.
    // `offset: 0` rather than omitted, so a hand-built envelope reports the
    // same five fields `applyLimit` does. This tool takes no `offset`
    // parameter: one budget spans two lists, so a single number could not say
    // which of them it meant to skip into — and neither list is one you page
    // through. `limit` here bounds context, it does not paginate.
    const shapedDisks =
        remaining === 0
            ? { items: [], total: disks.length, returned: 0, offset: 0, truncated: disks.length > 0 }
            : applyLimit(disks, remaining);

    // Counts stay honest at every detail level: a model must never see
    // returned: 0 and conclude there are no disks.
    // Sorted by id like the lists above, and read from each instance's own
    // config rather than from its adapter. For an OAuth caller, `app.ts` has
    // already capped these flags to the token's scopes, the same ceiling the
    // write gate applies, so this never reports a write the gate would refuse.
    const permissions =
        instances === undefined
            ? undefined
            : [...instances]
                  .map(i => ({
                      instance: i.id,
                      safe_write: i.config.permissions.safe_write,
                      destructive: i.config.permissions.destructive
                  }))
                  .sort((a, b) => a.instance.localeCompare(b.instance));

    // Same source as permissions, so a base URL and its permission set can
    // never disagree about which instance they describe.
    const endpoints =
        instances === undefined
            ? undefined
            : [...instances]
                  .map(i => ({ instance: i.id, service: i.type, baseUrl: withoutCredentials(i.config.url) }))
                  .sort((a, b) => a.instance.localeCompare(b.instance));

    return project(
        {
            services,
            disks: shapedDisks,
            failures: shapedFailures,
            scans,
            ...(permissions === undefined ? {} : { permissions }),
            ...(endpoints === undefined ? {} : { endpoints }),
            ...(options === undefined ? {} : { options }),
            ...(hasSeedingRules ? { seedingRules } : {}),
            ...(cleanup === undefined ? {} : { cleanup }),
            ...(cleanuparrRemovals === undefined ? {} : { cleanuparrRemovals }),
            // Its own `limit` budget, like `options`: a log line is not
            // competing with a failing health check for the same rows.
            ...(opts.detail === 'full' ? { logs: { ...applyLimit(logs, opts.limit), lines: logLines } } : {}),
            ...(opts.detail === 'minimal' ? {} : { commands }),
            ...(primaryMediaServer === undefined ? {} : { primaryMediaServer }),
            degraded
        },
        opts.detail
    );
}

/**
 * The rows behind the summary, in the text as well as in `structuredContent`:
 * not every client shows the structured half to the model (#234), and "is
 * anything broken" is not answered by a count. One line per service, then each
 * failing health check, then each disk, mounts of one filesystem folded into
 * one line.
 */
function healthLines(result: Pick<StackHealthResult, 'services' | 'failures' | 'disks'>): string[] {
    const services = result.services.map(s => {
        // A zero latency is a diagnosis built without a request, not a fast one.
        if (s.ok) return `${s.service} — ok${s.version === undefined ? '' : `, ${s.version}`}${s.latency_ms > 0 ? `, ${s.latency_ms} ms` : ''}`;
        const detail = s.error?.detail ?? 'no detail';
        const remedy = s.error?.remedy === undefined ? '' : `${/[.!?]$/u.test(detail) ? '' : '.'} ${s.error.remedy}`;
        return `${s.service} — ${s.error?.kind ?? 'failed'}: ${detail}${remedy}`;
    });
    const failures = result.failures.items.map(f => `${f.service} health check ${f.source} — ${f.type}: ${f.message}`);
    const disks = groupDisks(result.disks.items).map(
        d => `disk — ${humanBytes(d.freeSpace)} free${d.totalSpace === undefined ? '' : ` of ${humanBytes(d.totalSpace)}`}: ${d.mounts.join(', ')}`
    );
    return [...services, ...failures, ...disks];
}

/**
 * What the lines leave out. Failures and disks share one `limit`, and
 * `minimal` empties both, so a text that only listed what it kept would read
 * as complete when it is not.
 */
function shownLine(result: Pick<StackHealthResult, 'failures' | 'disks'>): string {
    const { failures, disks } = result;
    const parts = [
        ...(failures.total === 0
            ? []
            : [failures.returned === failures.total ? `${failures.total} failing health check(s)` : `${failures.returned} of ${failures.total} failing health check(s) shown`]),
        ...(disks.returned === disks.total ? [] : [`${disks.returned} of ${disks.total} disk(s) shown`])
    ];
    return parts.length === 0 ? '' : ` ${parts.join(', ')}.`;
}

/** One sentence on what is about to go, because that is the question a cleanup service raises. */
function cleanupLine(cleanup: CleanupOverview | undefined): string {
    const candidates = cleanup?.candidates;
    if (cleanup === undefined || candidates === undefined) return '';
    const off = cleanup.autoDelete?.enabled === false ? ' Its automatic deletion is off, so nothing goes on its own.' : '';
    if (candidates.total === 0) return ` ${cleanup.service} has nothing set to be deleted.${off}`;
    // Counted by the adapter before `limit` cut the list.
    const going = cleanup.going ?? { count: 0 };
    return ` ${cleanup.service}: ${candidates.total} cleanup candidate(s), ${going.count} set to go${going.firstAt === undefined ? '' : `, the first on ${going.firstAt.slice(0, 10)}`}.${off}`;
}

/**
 * The one read tool whose answer is not a list, so it declares its own shape
 * rather than the paged envelope. `disks` and `failures` are envelopes of
 * their own — one `limit` budget spans both, spent on failures first, which is
 * why neither is the top-level list. Keyed on whether a primary media server
 * exists, the only thing the shape depends on.
 */
const stackHealthOutput = memoBy((withPrimary: boolean) => z.looseObject({
    services: z.array(z.unknown()).describe('One row per configured instance: reachable, version, latency.'),
    failures: TruncationSchema.describe('Health checks the services themselves are reporting.'),
    disks: TruncationSchema.describe('Free space per root folder.'),
    scans: z.array(z.unknown()).describe('When each library was last scanned. Never truncated — bounded by the number of services.'),
    commands: z
        .array(z.unknown())
        .optional()
        .describe('Queued or running tasks, plus anything finished in the last fifteen minutes. Absent at `minimal`.'),
    permissions: z.array(z.unknown()).optional().describe('What each instance may do. Absent at `minimal` — a permission is not a fault.'),
    endpoints: z.array(z.unknown()).optional().describe('Where each instance lives. Never a credential.'),
    options: z
        .array(z.unknown())
        .optional()
        .describe('Quality profiles, root folders and tags each Radarr, Sonarr, Whisparr and Lidarr instance has. Only at `detail: "full"`.'),
    seedingRules: z
        .object({
            clients: z.array(z.unknown()),
            indexers: z.array(z.unknown()),
            cleanuparr: z.array(z.unknown()).optional(),
            coverage: z.array(z.unknown()).optional(),
            notes: z.array(z.string())
        })
        .optional()
        .describe('Client seed limits, indexer seed criteria, and where they disagree. Only at `detail: "full"`.'),
    cleanup: z
        .looseObject({ service: z.string() })
        .optional()
        .describe('What Reclaimerr is set to delete, soonest first, its rules and whether auto-delete runs. Only at `detail: "full"`.'),
    cleanuparrRemovals: z
        .object({ service: z.string(), queueCleaner: z.unknown().optional(), malwareBlocker: z.unknown().optional(), notes: z.array(z.string()) })
        .optional()
        .describe('When Cleanuparr removes a download and what the removal does. Only at `detail: "full"`, with Cleanuparr configured.'),
    logs: TruncationSchema.extend({
        lines: z.array(z.unknown()).describe('Per instance, how many log lines were `read` and the `total` the log holds. `total` above counts folded rows from those lines, not the log.')
    })
        .optional()
        .describe('Recent warnings and errors from each Radarr, Sonarr, Prowlarr, Seerr and Bazarr log, identical lines folded with a count. Only at `detail: "full"`.'),
    ...(withPrimary
        ? { primaryMediaServer: z.string().describe('The media server tools default to when `service` is not given.') }
        : {}),
    degraded: z.array(z.string())
}));

const StackHealthInput = toolInput({ detail: DetailSchema, limit: LimitSchema });

export function registerStackHealth(
    server: McpServer,
    adapters: readonly ServiceAdapter[],
    instances?: readonly ServiceInstance[],
    primaryMediaServer?: string
): void {
    server.registerTool(
        'stack_health',
        {
            title: 'Stack health',
            annotations: READ_ONLY,
            description:
                'Health of every configured service: version, disk space, failing health checks, last library scan, and what each instance may do (`permissions`, whose ids are the valid `instance` values). Answers partially, with a `degraded` list, when a service is down. `commands` follows up trigger_search and trigger_scan: queued, running, and finished in the last 15 minutes, so a command not listed has finished. `detail: "full"` adds `options` (the quality profiles, root folders and tags add_media and update_media need: read them here, never guess), `seedingRules` (client, indexer [[cleanuparr: and Cleanuparr ]]seed limits[[cleanuparr:  and removal rules]]), [[reclaimerr: Reclaimerr `cleanup` (what will be deleted or moved, and when), ]]and each service\'s recent warnings and errors in `logs`; check `lastSeen`, since an old line may no longer apply. API keys are never returned. Field reference: arr://docs/stack_health.',
            inputSchema: StackHealthInput,
            outputSchema: stackHealthOutput(primaryMediaServer !== undefined)
        },
        async ({ detail, limit }) => {
            const result = await buildStackHealth(adapters, { detail, limit }, instances, primaryMediaServer);
            const neverScanned = result.scans.filter(s => s.lastCompleted === undefined).length;
            const summary =
                (result.degraded.length === 0
                    ? `All ${result.services.length} configured service(s) healthy.` +
                      (neverScanned > 0 ? ` ${neverScanned} report no completed library scan.` : '')
                    : `${result.degraded.length} of ${result.services.length} service(s) degraded: ${result.degraded.join(', ')}.`) +
                (primaryMediaServer === undefined ? '' : ` ${primaryMediaServer} is the primary media server.`) +
                cleanupLine(result.cleanup) +
                shownLine(result);

            return {
                content: [{ type: 'text', text: listText(summary, healthLines(result), line => line) }],
                structuredContent: result
            };
        }
    );
}
