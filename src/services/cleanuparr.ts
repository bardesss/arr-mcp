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
    type CleanuparrSeeding,
    type ConnectionDiagnosis,
    type HealthCheck,
    type HealthCheckCapable,
    type HistoryCapable,
    type HistoryEntry,
    type HistoryEventType,
    type HistoryQuery,
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
type RawJob = { jobType?: string; status?: string };
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
    DownloadStopped: 'stopped',
    ForceImported: 'imported'
};
/** One upstream type per filter value, so the service filters before paging. */
const UPSTREAM: Partial<Record<HistoryEventType, string>> = { stopped: 'DownloadStopped', imported: 'ForceImported' };
/** Seeker's own searches are about no download, and would crowd out the rest. */
const DROPPED = new Set(['SearchTriggered']);
const PAGE_SIZE = 100;

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

const JOB_LABEL: Record<string, string> = { QueueCleaner: 'Queue Cleaner', DownloadCleaner: 'Download Cleaner' };

/**
 * Hand-written against the source at tag v2.10.9: Cleanuparr publishes no
 * API reference, and minor releases may break this contract.
 */
export class CleanuparrAdapter implements ServiceAdapter, HealthCheckCapable, CleanuparrCapable, HistoryCapable {
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
        const [version, health, arrs, clients, jobs, general] = await Promise.all([
            this.getVersion(),
            this.#http.get<RawHealth>('/health/detailed'),
            this.#http.get<RawArrStatus>(`${CLEANUPARR_API}/status/arrs`),
            this.#clients(),
            this.#jobs(),
            this.#general()
        ]);
        const check = (source: string, type: string, message: string): HealthCheck => ({ service: this.id, source, type, message });
        const fence = (value: string) => fenceText(value, { service: this.id, field: 'message' });
        const out: HealthCheck[] = [];

        for (const [name, entry] of Object.entries(health.entries ?? {})) {
            if (entry.status !== 'healthy') out.push(check('health', 'error', fence(`${name}: ${entry.description ?? entry.status ?? 'unknown'}`)));
        }
        for (const [kind, list] of Object.entries(arrs)) {
            for (const a of list) {
                if (a.isConnected === false) {
                    out.push(check('arrs', 'error', fence(`${kind} "${a.name ?? kind}" is not connected: ${a.message ?? 'no reason given'}`)));
                }
            }
        }
        for (const c of clients) {
            if (c.enabled && !c.isConnected) out.push(check('clients', 'error', fence(`Download client "${c.name}" is not connected`)));
        }
        for (const job of jobs) {
            const label = JOB_LABEL[job.jobType ?? ''];
            if (label !== undefined && job.status !== 'Scheduled') out.push(check('jobs', 'warning', `${label} is not scheduled, so its rules are not enforced`));
        }
        if (general.dryRun === true) out.push(check('general', 'warning', 'Dry run is on: Cleanuparr logs what it would do and does nothing'));

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
            this.#http.get<{ ignoredDownloads?: string[] }>(`${CLEANUPARR_API}/configuration/download_cleaner`)
        ]);
        const sets = await Promise.all(
            clients.map(async c => {
                const rules = await this.#http.get<RawRule[]>(`${CLEANUPARR_API}/seeding-rules/${encodeURIComponent(c.id)}`);
                const endpoint = hostPort(c.host);
                return {
                    client: c.name,
                    clientType: c.type,
                    ...(endpoint === undefined ? {} : { endpoint }),
                    rules: rules.map(r => ruleOf(r, this.id)).sort((a, b) => a.priority - b.priority)
                };
            })
        );
        return {
            sets,
            dryRun: general.dryRun === true,
            enforced: jobs.some(j => j.jobType === 'DownloadCleaner' && j.status === 'Scheduled'),
            ignored: [...(general.ignoredDownloads ?? []), ...(cleaner.ignoredDownloads ?? [])].filter(v => v.trim() !== '')
        };
    }

    /** The client list without credentials. `/api/configuration/download_client` has passwords. */
    async readHistory(opts: HistoryQuery): Promise<Window<HistoryEntry>> {
        const upstream = opts.eventType === undefined ? undefined : UPSTREAM[opts.eventType];
        // A filter the service cannot apply means every page is read, to count the matches.
        const local = opts.eventType !== undefined && upstream === undefined;
        const base = [
            ...(opts.since === undefined ? [] : [`fromDate=${encodeURIComponent(opts.since)}`]),
            ...(upstream === undefined ? [] : [`eventType=${upstream}`]),
            `pageSize=${PAGE_SIZE}`
        ];
        const items: HistoryEntry[] = [];
        let dropped = 0;
        for (let page = 1; ; page += 1) {
            const body = await this.#http.get<RawPage<RawEvent>>(`${CLEANUPARR_API}/events?${[...base, `page=${page}`].join('&')}`);
            for (const e of body.items ?? []) {
                const entry = this.#entryOf(e);
                if (entry === undefined) dropped += 1;
                else if (opts.eventType === undefined || entry.event === opts.eventType) items.push(entry);
            }
            if (page >= (body.totalPages ?? 1)) return { items, total: items.length };
            if (!local && opts.want !== undefined && items.length >= opts.want) {
                return { items, total: Math.max(items.length, (body.totalCount ?? 0) - dropped) };
            }
        }
    }

    #entryOf(e: RawEvent): HistoryEntry | undefined {
        if (e.id === undefined || e.eventType === undefined || DROPPED.has(e.eventType)) return undefined;
        const fence = (value: string, field: string) => fenceText(value, { service: this.id, field });
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
            ...(e.isDryRun === true ? { dryRun: true as const } : {})
        };
    }

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
