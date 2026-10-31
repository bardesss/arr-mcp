import type { ConfigByService, ServiceId } from '../config/schema.ts';
import { apiKeyHeader } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { fenceText } from '../core/fence.ts';
import type { CleanuparrRule, RuleAction, RulePrivacy } from '../core/cleanuparrRules.ts';
import { hostPort } from '../core/hostPort.ts';
import { ServiceHttp } from '../core/http.ts';
import {
    diagnoseConnection,
    type CleanuparrCapable,
    type CleanuparrMalwareBlocker,
    type CleanuparrQueueCleaner,
    type CleanuparrRemovalCapable,
    type CleanuparrRemovals,
    type CleanuparrRuleSet,
    type CleanuparrSeeding,
    type CleanuparrStrikeLimit,
    type ConnectionDiagnosis,
    type HealthCheck,
    type HealthCheckCapable,
    type HistoryCapable,
    type HistoryEntry,
    type HistoryEventType,
    type HistoryQuery,
    type PrivateTorrentHandling,
    type ServiceAdapter,
    type Window
} from './types.ts';
import { compareVersions, parseVersion } from './versions.ts';

export const CLEANUPARR_API = '/api';

export const TESTED_MINOR = '2.10';

type RawStatus = { application?: { version?: string } };
type RawHealthEntry = { status?: string; description?: string };
type RawHealth = { entries?: Record<string, RawHealthEntry> };
type RawArrStatus = Record<string, Array<{ name?: string; isConnected?: boolean; message?: string }>>;
export type RawClientStatus = { id: string; name: string; type: string; host: string; enabled: boolean; isConnected: boolean };
type RawJob = { jobType?: string; status?: string; nextRunTime?: string | null };

/** A job that is running or done is still on its schedule; `Not Scheduled`, `Paused` and `Error` are not. */
const ON_SCHEDULE = new Set(['Scheduled', 'Running', 'Complete']);

/** Cleanuparr's StrikeType values: a strike's event is the type plus `Strike`, a reset names the type in its message. */
const STRIKE_TYPES = new Set(['Stalled', 'DownloadingMetadata', 'FailedImport', 'SlowSpeed', 'SlowTime', 'DeadTorrent', 'Errored']);

function strikeTypeOf(e: { eventType?: string; message?: string | null }): string | undefined {
    if (e.eventType === 'StrikeReset') {
        const named = /'(\w+)' strike\(s\) reset/.exec(e.message ?? '')?.[1];
        return named !== undefined && STRIKE_TYPES.has(named) ? named : undefined;
    }
    const type = e.eventType?.endsWith('Strike') === true ? e.eventType.slice(0, -'Strike'.length) : undefined;
    return type !== undefined && STRIKE_TYPES.has(type) ? type : undefined;
}
export type RawGeneral = { dryRun?: boolean; ignoredDownloads?: string[] };

type RawRule = {
    id?: string;
    name?: string;
    categories?: string[];
    trackerPatterns?: string[];
    tagsAny?: string[] | null;
    tagsAll?: string[] | null;
    priority?: number;
    privacyType?: string;
    maxRatio?: number | null;
    minSeedTime?: number | null;
    maxSeedTime?: number | null;
    minSeeders?: number | null;
    maxInactiveDays?: number | null;
    deleteSourceFiles?: boolean;
    action?: string;
};

type RawCategoryModule = { enabled?: boolean; targetCategory?: string; useTag?: boolean; categories?: string[] };
type RawOrphaned = {
    enabled?: boolean;
    scanDirectories?: string[];
    orphanedDirectory?: string;
    excludePatterns?: string[];
    minFileAgeHours?: number;
    purgeAfterHours?: number | null;
};
type RawCleanerClient = {
    downloadClientId?: string;
    unlinkedConfig?: (RawCategoryModule & { ignoredRootDirs?: string[] }) | null;
    deadTorrentConfig?: (RawCategoryModule & { maxStrikes?: number }) | null;
    orphanedFilesConfig?: RawOrphaned | null;
};
type RawCleaner = { ignoredDownloads?: string[]; clients?: RawCleanerClient[] };

const nonEmpty = (list: string[] | undefined): string[] => (list ?? []).filter(v => typeof v === 'string' && v.trim() !== '');

/** The per-client modules arrived in 2.10; a client Cleanuparr reports none for carries none. */
function modulesOf(raw: RawCleanerClient | undefined, service: string): Pick<CleanuparrRuleSet, 'unlinked' | 'deadTorrents' | 'orphanedFiles' | 'orphanScan'> {
    if (raw === undefined) return {};
    const path = (p: string) => fenceText(p, { service, field: 'path' });
    const u = raw.unlinkedConfig;
    const d = raw.deadTorrentConfig;
    const o = raw.orphanedFilesConfig;
    const ignoredRootDirs = nonEmpty(u?.ignoredRootDirs).map(path);
    const scan = nonEmpty(o?.scanDirectories);
    const purge = o?.purgeAfterHours;
    return {
        ...(u == null
            ? {}
            : {
                  unlinked:
                      u.enabled === true
                          ? {
                                enabled: true,
                                categories: nonEmpty(u.categories),
                                target: u.targetCategory ?? '',
                                ...(u.useTag === true ? { useTag: true as const } : {}),
                                ...(ignoredRootDirs.length === 0 ? {} : { ignoredRootDirs })
                            }
                          : { enabled: false }
              }),
        ...(d == null
            ? {}
            : {
                  deadTorrents:
                      d.enabled === true
                          ? {
                                enabled: true,
                                categories: nonEmpty(d.categories),
                                target: d.targetCategory ?? '',
                                ...(d.useTag === true ? { useTag: true as const } : {}),
                                maxStrikes: d.maxStrikes ?? 0
                            }
                          : { enabled: false }
              }),
        ...(o == null
            ? {}
            : o.enabled === true
              ? {
                    orphanedFiles: {
                        enabled: true,
                        scanDirectories: scan.map(path),
                        orphanedDirectory: path(o.orphanedDirectory ?? ''),
                        excludePatterns: nonEmpty(o.excludePatterns),
                        minFileAgeHours: o.minFileAgeHours ?? 0,
                        ...(typeof purge === 'number' && purge > 0 ? { purgeAfterHours: purge } : {})
                    },
                    orphanScan: { scanDirectories: scan, orphanedDirectory: o.orphanedDirectory ?? '' }
                }
              : { orphanedFiles: { enabled: false } })
    };
}

type RawEvent = {
    id?: string;
    timestamp?: string;
    eventType?: string;
    message?: string;
    isDryRun?: boolean;
    itemTitle?: string | null;
    itemHash?: string | null;
    strikeCount?: number | null;
    failedImportReasons?: string[];
    deleteReason?: string | null;
    cleanReason?: string | null;
    downloadClientId?: string | null;
    oldCategory?: string | null;
    newCategory?: string | null;
};
type RawPage<T> = { items?: T[]; totalCount?: number; totalPages?: number };

const EVENT: Record<string, HistoryEventType> = {
    QueueItemDeleted: 'deleted',
    DownloadCleaned: 'deleted',
    FailedImportStrike: 'strike',
    StalledStrike: 'strike',
    DownloadingMetadataStrike: 'strike',
    SlowSpeedStrike: 'strike',
    SlowTimeStrike: 'strike',
    DeadTorrentStrike: 'strike',
    ErroredStrike: 'strike',
    DownloadStopped: 'stopped',
    ForceImported: 'imported',
    StrikeReset: 'recovered',
    CategoryChanged: 'recategorised'
};
/** One upstream type per filter value, so the service filters before paging. */
const UPSTREAM: Partial<Record<HistoryEventType, string>> = {
    stopped: 'DownloadStopped',
    imported: 'ForceImported',
    recovered: 'StrikeReset',
    recategorised: 'CategoryChanged'
};
/** Everything else Cleanuparr never emits, so a filter for it reads nothing. */
const EMITTED = new Set<HistoryEventType>(['deleted', 'strike', 'stopped', 'imported', 'recovered', 'recategorised', 'unknown']);
/** Seeker's own searches are about no download, and would crowd out the rest. */
const DROPPED = new Set(['SearchTriggered']);
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

const PRIVACY: Record<string, RulePrivacy> = { Public: 'public', Private: 'private', Both: 'both' };
const ACTION: Record<string, RuleAction> = { Delete: 'delete', Stop: 'stop' };

/** -1 is "no limit", and minSeedTime/minSeeders use 0 for "off". */
const limit = (v: number | null | undefined, off: number): number | undefined =>
    v === null || v === undefined || v === off || v < 0 ? undefined : v;

const optional = <K extends string>(key: K, v: number | undefined): Partial<Record<K, number>> =>
    (v === undefined ? {} : { [key]: v }) as Partial<Record<K, number>>;

function ruleOf(r: RawRule, service: string): CleanuparrRule {
    const nullable = ['tagsAny', 'tagsAll', 'minSeeders', 'maxInactiveDays'] as const;
    return {
        id: r.id ?? '',
        name: fenceText(r.name ?? '', { service, field: 'rule' }),
        priority: r.priority ?? Number.MAX_SAFE_INTEGER,
        categories: r.categories ?? [],
        trackerPatterns: r.trackerPatterns ?? [],
        tagsAny: r.tagsAny ?? [],
        tagsAll: r.tagsAll ?? [],
        privacy: PRIVACY[r.privacyType ?? ''] ?? 'both',
        ...optional('maxRatio', limit(r.maxRatio, -1)),
        ...optional('minSeedHours', limit(r.minSeedTime, 0)),
        ...optional('maxSeedHours', limit(r.maxSeedTime, -1)),
        ...optional('minSeeders', limit(r.minSeeders, 0)),
        ...optional('maxInactiveDays', limit(r.maxInactiveDays, -1)),
        unsupported: nullable.filter(k => r[k] === null),
        deleteSourceFiles: r.deleteSourceFiles ?? false,
        action: ACTION[r.action ?? ''] ?? 'unknown'
    };
}

type RawQueueCleaner = {
    enabled?: boolean;
    cronExpression?: string;
    failedImport?: {
        maxStrikes?: number;
        ignorePrivate?: boolean;
        deletePrivate?: boolean;
        patterns?: string[];
        patternMode?: string;
        changeCategory?: boolean;
        forceImport?: boolean;
    };
    ignoredDownloads?: string[];
    processNoContentId?: boolean;
    downloadingMetadataMaxStrikes?: number;
    /** Since 2.10.11; absent on older builds. */
    errored?: { maxStrikes?: number; ignorePrivate?: boolean; deletePrivate?: boolean; changeCategory?: boolean };
};
type RawQueueRule = {
    name?: string;
    enabled?: boolean;
    maxStrikes?: number;
    privacyType?: string;
    minCompletionPercentage?: number;
    maxCompletionPercentage?: number;
    deletePrivateTorrentsFromClient?: boolean;
    changeCategory?: boolean;
    minSpeed?: string;
    maxTimeHours?: number;
};
type RawBlocklist = { enabled?: boolean; blocklistType?: string; blocklistPath?: string | null };

/** ContentBlockerConfigResponse has one blocklist per *arr, under these keys. */
const BLOCKLIST_ARRS = ['sonarr', 'radarr', 'lidarr', 'readarr', 'whisparr', 'sportarr', 'lazyLibrarian'] as const;

type RawMalwareBlocker = {
    enabled?: boolean;
    cronExpression?: string;
    ignorePrivate?: boolean;
    deletePrivate?: boolean;
    processNoContentId?: boolean;
    deleteIfAnyFileBlocked?: boolean;
    ignoredDownloads?: string[];
} & Partial<Record<(typeof BLOCKLIST_ARRS)[number], RawBlocklist>>;

const APPLIES: Record<string, CleanuparrStrikeLimit['appliesTo']> = { Public: 'public', Private: 'private', Both: 'both' };

/** A ByteSize string such as `1MB` or `500 KB`; anything else is not passed on. */
const BYTE_SIZE = /^\d+(?:[.,]\d+)?\s?[a-z]{0,3}(?:\/s)?$/i;

/** A category change leaves the torrent in the client; otherwise the flag decides. */
const privateOf = (changeCategory: boolean, deletes: boolean): Exclude<PrivateTorrentHandling, 'skipped'> =>
    !changeCategory && deletes ? 'deleted_from_client' : 'kept_in_client';

const nonBlank = (list: string[] | undefined): number => (list ?? []).filter(v => v.trim() !== '').length;

/** A URL keeps only its host, so a token in its path or query never leaves; a local path is just `file`. */
function sourceOf(path: string | null | undefined): string {
    try {
        const url = new URL(path ?? '');
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname : 'file';
    } catch {
        return 'file';
    }
}

function queueRuleOf(r: RawQueueRule, strike: 'Stalled' | 'Slow', service: string): CleanuparrStrikeLimit {
    const appliesTo = APPLIES[r.privacyType ?? ''] ?? 'public';
    const changeCategory = r.changeCategory === true;
    const [min, max] = [r.minCompletionPercentage ?? 0, r.maxCompletionPercentage ?? 100];
    const speed = r.minSpeed?.trim() ?? '';
    return {
        strike,
        rule: fenceText(r.name ?? '', { service, field: 'rule' }),
        maxStrikes: r.maxStrikes ?? 0,
        atLimit: changeCategory ? 'change_category' : 'remove',
        appliesTo,
        ...(appliesTo === 'public' ? {} : { privateTorrents: privateOf(changeCategory, r.deletePrivateTorrentsFromClient === true) }),
        ...(min === 0 && max === 100 ? {} : { completion: `${min}-${max}%` }),
        ...(BYTE_SIZE.test(speed) ? { minSpeed: speed } : {}),
        ...(typeof r.maxTimeHours === 'number' && r.maxTimeHours > 0 ? { maxTimeHours: r.maxTimeHours } : {})
    };
}

function queueCleanerOf(
    config: RawQueueCleaner,
    rules: { stall: RawQueueRule[]; slow: RawQueueRule[] },
    scheduled: boolean | undefined,
    searchesAgain: boolean | undefined,
    service: string
): CleanuparrQueueCleaner {
    const strikes: CleanuparrStrikeLimit[] = [];
    const failed = config.failedImport ?? {};
    // 0 is off. A per-arr override can still turn it on, and that setting is served beside the arr's API key.
    if ((failed.maxStrikes ?? 0) > 0) {
        const changeCategory = failed.changeCategory === true;
        strikes.push({
            strike: 'FailedImport',
            maxStrikes: failed.maxStrikes ?? 0,
            atLimit: changeCategory ? 'change_category' : 'remove',
            appliesTo: failed.ignorePrivate === true ? 'public' : 'both',
            ...(failed.ignorePrivate === true ? {} : { privateTorrents: privateOf(changeCategory, failed.deletePrivate === true) }),
            patterns: { mode: failed.patternMode === 'Exclude' ? 'exclude' : 'include', count: nonBlank(failed.patterns) },
            ...(failed.forceImport === true ? { forceImport: true } : {})
        });
    }
    // qBittorrent only, and it removes from the client whatever the torrent's privacy.
    if ((config.downloadingMetadataMaxStrikes ?? 0) > 0) {
        strikes.push({
            strike: 'DownloadingMetadata',
            maxStrikes: config.downloadingMetadataMaxStrikes ?? 0,
            atLimit: 'remove',
            appliesTo: 'both',
            privateTorrents: 'deleted_from_client'
        });
    }
    // Any torrent client. Each strike asks the client to resume the download first.
    const errored = config.errored ?? {};
    if ((errored.maxStrikes ?? 0) > 0) {
        const changeCategory = errored.changeCategory === true;
        strikes.push({
            strike: 'Errored',
            maxStrikes: errored.maxStrikes ?? 0,
            atLimit: changeCategory ? 'change_category' : 'remove',
            appliesTo: errored.ignorePrivate === true ? 'public' : 'both',
            ...(errored.ignorePrivate === true ? {} : { privateTorrents: privateOf(changeCategory, errored.deletePrivate === true) })
        });
    }
    strikes.push(...rules.stall.filter(r => r.enabled !== false).map(r => queueRuleOf(r, 'Stalled', service)));
    strikes.push(...rules.slow.filter(r => r.enabled !== false).map(r => queueRuleOf(r, 'Slow', service)));
    return {
        enabled: config.enabled === true,
        ...(scheduled === undefined ? {} : { scheduled }),
        schedule: config.cronExpression ?? '',
        strikes,
        onRemoval: { blocklisted: true, ...(searchesAgain === undefined ? {} : { searchesAgain }) },
        processNoContentId: config.processNoContentId === true,
        ignoredCount: nonBlank(config.ignoredDownloads)
    };
}

function malwareBlockerOf(config: RawMalwareBlocker, scheduled: boolean | undefined): CleanuparrMalwareBlocker {
    const blocklists = BLOCKLIST_ARRS.flatMap(arr => {
        const b = config[arr];
        if (b?.enabled !== true) return [];
        const type = b.blocklistType === 'Whitelist' ? ('whitelist' as const) : ('blacklist' as const);
        return [{ arr: arr.toLowerCase(), type, source: sourceOf(b.blocklistPath) }];
    });
    const privateTorrents: PrivateTorrentHandling =
        config.ignorePrivate === true ? 'skipped' : config.deletePrivate === true ? 'deleted_from_client' : 'kept_in_client';
    return {
        enabled: config.enabled === true,
        ...(scheduled === undefined ? {} : { scheduled }),
        schedule: config.cronExpression ?? '',
        blocklists,
        removesWhen: config.deleteIfAnyFileBlocked === true ? 'any_file_blocked' : 'all_files_blocked',
        privateTorrents,
        processNoContentId: config.processNoContentId === true,
        ignoredCount: nonBlank(config.ignoredDownloads)
    };
}

const STRIKE_LABEL: Record<CleanuparrStrikeLimit['strike'], string> = {
    FailedImport: 'failed-import strikes',
    DownloadingMetadata: 'metadata strikes',
    Errored: 'errored-download strikes',
    Stalled: 'stall rule',
    Slow: 'slow rule'
};

/** Only settings the source shows delete a private torrent's files. A metadata stall has no files to seed. */
function removalNotes(queue: CleanuparrQueueCleaner | undefined, malware: CleanuparrMalwareBlocker | undefined): string[] {
    const notes: string[] = [];
    const hitAndRun = 'which ends its seeding and can count as a hit-and-run on a private tracker';
    for (const s of queue?.enabled === true ? queue.strikes : []) {
        if (s.strike === 'DownloadingMetadata' || s.atLimit !== 'remove' || s.privateTorrents !== 'deleted_from_client') continue;
        const what = s.rule === undefined ? STRIKE_LABEL[s.strike] : `${STRIKE_LABEL[s.strike]} ${s.rule}`;
        notes.push(`Queue Cleaner's ${what} deletes a private torrent and its files from the download client after ${s.maxStrikes} strikes, ${hitAndRun}.`);
    }
    if (malware?.enabled === true && malware.privateTorrents === 'deleted_from_client') {
        notes.push(`Malware Blocker deletes a blocked private torrent and its files from the download client, ${hitAndRun}.`);
    }
    return notes;
}

/**
 * Hand-written against the source at tag v2.10.9 and checked live on 2.10.12:
 * Cleanuparr publishes no API reference, and minor releases may break this contract.
 */
export class CleanuparrAdapter implements ServiceAdapter, HealthCheckCapable, CleanuparrCapable, CleanuparrRemovalCapable, HistoryCapable {
    readonly type: ServiceId = 'cleanuparr';
    readonly id = 'cleanuparr';
    readonly #http: ServiceHttp;

    constructor(config: ConfigByService['cleanuparr'], fetchImpl: typeof fetch = fetch) {
        this.#http = new ServiceHttp(this.id, config, apiKeyHeader('X-Api-Key', config.api_key), fetchImpl);
    }

    /** Reported as `2.10.9.0`; the fourth part is a build number. */
    async getVersion(): Promise<string> {
        const status = await this.#http.get<RawStatus>(`${CLEANUPARR_API}/status`);
        const raw = status.application?.version;
        if (!raw) throw new ServiceError('UpstreamError', this.id, 'status returned no version field');
        return raw.split('.').slice(0, 3).join('.');
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, this.type, () => this.getVersion());
    }

    async getFailedHealthChecks(): Promise<HealthCheck[]> {
        // One missing endpoint on an older 2.10.x must not hide the rest; only the version read is fatal.
        const [version, settled] = await Promise.all([
            this.getVersion(),
            Promise.allSettled([
                this.#http.get<RawHealth>('/health/detailed'),
                this.#http.get<RawArrStatus>(`${CLEANUPARR_API}/status/arrs`),
                this.#clients(),
                this.#jobs(),
                this.#general()
            ])
        ]);
        const check = (source: string, type: string, message: string): HealthCheck => ({ service: this.id, source, type, message });
        const fence = (value: string) => fenceText(value, { service: this.id, field: 'message' });
        const out: HealthCheck[] = [];
        const read = <T>(source: string, result: PromiseSettledResult<T>): T | undefined => {
            if (result.status === 'fulfilled') return result.value;
            out.push(check(source, 'warning', `Could not read ${source} from Cleanuparr, so its findings are missing`));
            return undefined;
        };
        const [health, arrs, clients, jobs, general] = [
            read('health', settled[0]),
            read('arrs', settled[1]),
            read('clients', settled[2]),
            read('jobs', settled[3]),
            read('general', settled[4])
        ];

        for (const [name, entry] of Object.entries(health?.entries ?? {})) {
            if (entry.status !== 'healthy') out.push(check('health', 'error', fence(`${name}: ${entry.description ?? entry.status ?? 'unknown'}`)));
        }
        for (const [kind, list] of Object.entries(arrs ?? {})) {
            for (const a of list) {
                if (a.isConnected === false) {
                    out.push(check('arrs', 'error', fence(`${kind} "${a.name ?? kind}" is not connected: ${a.message ?? 'no reason given'}`)));
                }
            }
        }
        for (const c of clients ?? []) {
            if (c.enabled && !c.isConnected) out.push(check('clients', 'error', fence(`Download client "${c.name}" is not connected`)));
        }
        // The Download Cleaner is covered by the seeding rules note, which knows whether any rules exist.
        if ((jobs ?? []).some(j => j.jobType === 'QueueCleaner' && !ON_SCHEDULE.has(j.status ?? ''))) {
            out.push(check('jobs', 'warning', 'Queue Cleaner is not scheduled, so its rules are not enforced'));
        }
        if (general?.dryRun === true) out.push(check('general', 'warning', 'Dry run is on: Cleanuparr logs what it would do and does nothing'));

        const actual = parseVersion(version);
        const tested = parseVersion(TESTED_MINOR);
        if (actual !== undefined && tested !== undefined && compareVersions(actual.slice(0, 2), tested) > 0) {
            out.push(check('version', 'warning', `Cleanuparr ${version} is newer than ${TESTED_MINOR}.x, which this adapter was written against; untested, results may be wrong`));
        }
        return out;
    }

    async getSeedingRules(): Promise<CleanuparrSeeding> {
        const [clients, jobs, general, cleaner] = await Promise.all([
            this.#clients(),
            this.#jobs(),
            this.#general(),
            this.#http.get<RawCleaner>(`${CLEANUPARR_API}/configuration/download_cleaner`)
        ]);
        const cleanerOf = (id: string) => (cleaner.clients ?? []).find(c => c.downloadClientId?.toLowerCase() === id.toLowerCase());
        // Cleanuparr applies no rules for a disabled client.
        const sets = await Promise.all(
            clients.filter(c => c.enabled).map(async c => {
                const rules = await this.#http.get<RawRule[]>(`${CLEANUPARR_API}/seeding-rules/${encodeURIComponent(c.id)}`);
                const endpoint = hostPort(c.host);
                return {
                    client: fenceText(c.name, { service: this.id, field: 'client' }),
                    clientType: c.type,
                    ...(endpoint === undefined ? {} : { endpoint }),
                    rules: rules.map(r => ruleOf(r, this.id)).sort((a, b) => a.priority - b.priority),
                    ...modulesOf(cleanerOf(c.id), this.id)
                };
            })
        );
        const cleanerJob = jobs.find(j => j.jobType === 'DownloadCleaner' && ON_SCHEDULE.has(j.status ?? ''));
        const nextRun = cleanerJob?.nextRunTime == null ? NaN : Date.parse(cleanerJob.nextRunTime);
        return {
            sets,
            dryRun: general.dryRun === true,
            enforced: cleanerJob !== undefined,
            ...(Number.isNaN(nextRun) ? {} : { nextRunAt: new Date(nextRun).toISOString() }),
            ignored: [...(general.ignoredDownloads ?? []), ...(cleaner.ignoredDownloads ?? [])].filter(v => v.trim() !== '')
        };
    }

    /**
     * The Queue Cleaner and Malware Blocker settings that decide when a download is removed. Neither response
     * carries a credential. The per-arr failed-import override is not read: it is served beside the arr's API key.
     */
    async getRemovalRules(): Promise<CleanuparrRemovals> {
        const [queue, malware, jobs, seeker] = await Promise.allSettled([
            Promise.all([
                this.#http.get<RawQueueCleaner>(`${CLEANUPARR_API}/configuration/queue_cleaner`),
                this.#http.get<RawQueueRule[]>(`${CLEANUPARR_API}/queue-rules/stall`),
                this.#http.get<RawQueueRule[]>(`${CLEANUPARR_API}/queue-rules/slow`)
            ]),
            this.#http.get<RawMalwareBlocker>(`${CLEANUPARR_API}/configuration/malware_blocker`),
            this.#jobs(),
            this.#http.get<{ searchEnabled?: boolean }>(`${CLEANUPARR_API}/configuration/seeker`)
        ]);
        if (queue.status === 'rejected' && malware.status === 'rejected') throw queue.reason;
        const scheduled = (type: string): boolean | undefined =>
            jobs.status === 'fulfilled' ? jobs.value.some(j => j.jobType === type && ON_SCHEDULE.has(j.status ?? '')) : undefined;
        const searchesAgain = seeker.status === 'fulfilled' && typeof seeker.value.searchEnabled === 'boolean' ? seeker.value.searchEnabled : undefined;

        const queueCleaner =
            queue.status === 'fulfilled'
                ? queueCleanerOf(queue.value[0], { stall: queue.value[1], slow: queue.value[2] }, scheduled('QueueCleaner'), searchesAgain, this.id)
                : undefined;
        const malwareBlocker = malware.status === 'fulfilled' ? malwareBlockerOf(malware.value, scheduled('MalwareBlocker')) : undefined;
        const unread = [
            ...(queue.status === 'rejected' ? ['Queue Cleaner'] : []),
            ...(malware.status === 'rejected' ? ['Malware Blocker'] : [])
        ];
        return {
            ...(queueCleaner === undefined ? {} : { queueCleaner }),
            ...(malwareBlocker === undefined ? {} : { malwareBlocker }),
            notes: [...removalNotes(queueCleaner, malwareBlocker), ...unread.map(m => `Could not read the ${m} settings from Cleanuparr.`)]
        };
    }

    async readHistory(opts: HistoryQuery): Promise<Window<HistoryEntry>> {
        if (opts.id !== undefined) {
            throw new ServiceError('NotFound', this.id, 'Cleanuparr has no per-movie or per-series history', {
                remedy: 'Scope `id` to radarr or sonarr, which know what the id means. Cleanuparr answers for the whole stack.'
            });
        }
        if (opts.eventType !== undefined && !EMITTED.has(opts.eventType)) return { items: [], total: 0 };
        const upstream = opts.eventType === undefined ? undefined : UPSTREAM[opts.eventType];
        // A filter the service cannot apply means every page is read, to count the matches.
        const local = opts.eventType !== undefined && upstream === undefined;
        const base = [
            ...(opts.since === undefined ? [] : [`fromDate=${encodeURIComponent(opts.since)}`]),
            ...(upstream === undefined ? [] : [`eventType=${upstream}`]),
            `pageSize=${PAGE_SIZE}`
        ];
        // Without the client list, events just go unlabelled.
        const clients = await this.#clients().then(
            list => new Map(list.map(c => [c.id, c.name])),
            () => undefined
        );
        const items: HistoryEntry[] = [];
        let dropped = 0;
        for (let page = 1; ; page += 1) {
            const body = await this.#http.get<RawPage<RawEvent>>(`${CLEANUPARR_API}/events?${[...base, `page=${page}`].join('&')}`);
            for (const e of body.items ?? []) {
                const entry = this.#entryOf(e, clients);
                if (entry === undefined) dropped += 1;
                else if (opts.eventType === undefined || entry.event === opts.eventType) items.push(entry);
            }
            const pages = Number.isFinite(body.totalPages) ? (body.totalPages as number) : 1;
            // Past the cap or on an empty page the read stops, and total is what was read.
            if (page >= pages || page >= MAX_PAGES || (body.items ?? []).length === 0) return { items, total: items.length };
            if (!local && opts.want !== undefined && items.length >= opts.want) {
                return { items, total: Math.max(items.length, (body.totalCount ?? 0) - dropped) };
            }
        }
    }

    #entryOf(e: RawEvent, clients: Map<string, string> | undefined): HistoryEntry | undefined {
        if (e.id === undefined || e.eventType === undefined || DROPPED.has(e.eventType)) return undefined;
        const fence = (value: string, field: string) => fenceText(value, { service: this.id, field });
        const strikeType = strikeTypeOf(e);
        const reasons = [e.deleteReason, e.cleanReason, ...(e.failedImportReasons ?? [])].filter((r): r is string => typeof r === 'string' && r !== '');
        return {
            service: this.id,
            id: e.id,
            at: e.timestamp ?? '',
            event: EVENT[e.eventType] ?? 'unknown',
            rawEvent: e.eventType,
            title: fence(e.itemTitle ?? e.message ?? '', 'itemTitle'),
            ...(reasons.length === 0 ? {} : { reason: fence(reasons.join('; '), 'reason') }),
            ...(e.itemHash ? { downloadId: e.itemHash.toLowerCase() } : {}),
            ...(typeof e.strikeCount === 'number' ? { strikeCount: e.strikeCount } : {}),
            ...(strikeType === undefined ? {} : { strikeType }),
            ...(e.isDryRun === true ? { dryRun: true as const } : {}),
            ...(e.oldCategory ? { oldCategory: e.oldCategory } : {}),
            ...(e.newCategory ? { newCategory: e.newCategory } : {}),
            ...this.#clientOf(e.downloadClientId, clients)
        };
    }

    /** A deleted client takes its name with it, so only the fact of its removal is left. */
    #clientOf(id: string | null | undefined, clients: Map<string, string> | undefined): Pick<HistoryEntry, 'downloadClient' | 'clientRemoved'> {
        if (!id || clients === undefined) return {};
        const name = clients.get(id);
        return name === undefined ? { clientRemoved: true } : { downloadClient: fenceText(name, { service: this.id, field: 'client' }) };
    }

    /** The client list without credentials. `/api/configuration/download_client` has passwords. */
    async #clients(): Promise<RawClientStatus[]> {
        const body = await this.#http.get<{ Clients?: RawClientStatus[] }>(`${CLEANUPARR_API}/status/download-client`);
        return body.Clients ?? [];
    }

    async #jobs(): Promise<RawJob[]> {
        return this.#http.get<RawJob[]>(`${CLEANUPARR_API}/jobs`);
    }

    async #general(): Promise<RawGeneral> {
        return this.#http.get<RawGeneral>(`${CLEANUPARR_API}/configuration/general`);
    }
}
