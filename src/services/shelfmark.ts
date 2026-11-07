import { createHash } from 'node:crypto';
import type { ConfigByService, ServiceId } from '../config/schema.ts';
import { apiKeyHeader, noAuth } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { fenceText } from '../core/fence.ts';
import { ServiceHttp } from '../core/http.ts';
import { RELEASE_SEARCH_TIMEOUT_MS } from './arrRelease.ts';
import {
    diagnoseConnection,
    type ConnectionDiagnosis,
    type HealthCheck,
    type HealthCheckCapable,
    type HistoryCapable,
    type HistoryEntry,
    type HistoryEventType,
    type HistoryQuery,
    type QueueCapable,
    type QueueItem,
    type QueueRemoveCapable,
    type ReleaseCandidate,
    type ReleaseGrabCapable,
    type ReleaseScope,
    type ReleaseSearchCapable,
    type RemoveQueueOptions,
    type RetryCapable,
    type RetryMethod,
    type RetryOutcome,
    type RetryTarget,
    type SearchCapable,
    type SearchHit,
    type SearchSource,
    type ServiceAdapter
} from './types.ts';

const HEALTH_PATH = '/api/health';
const STATS_PATH = '/api/stats';
const CONFIG_PATH = '/api/config';
const STATUS_PATH = '/api/status';

/** The buckets of `/api/status` that belong in a queue, in the order a book moves through them. */
const QUEUE_STATUSES = ['downloading', 'locating', 'resolving', 'queued', 'error'] as const;

const SEARCH_PATH = '/api/metadata/search';
const RELEASES_PATH = '/api/releases';
const DOWNLOAD_PATH = '/api/releases/download';
const SEARCH_LIMIT = 20;
/** Shelfmark has no indexer ids: the guid alone names a release. `grab_release` takes this back verbatim. */
const NO_INDEXER_ID = 0;
const RELEASES_FRESH_MS = 5 * 60_000;
const LISTINGS_KEPT = 20;

const SNAPSHOT_PATH = '/api/activity/snapshot';
/** Only what someone dismissed from Shelfmark's activity sidebar. The rest of its history is in the snapshot. */
const DISMISSED_PATH = '/api/activity/history?limit=500';
/** Shelfmark's words for a download that has stopped, and what `get_history` calls each. */
const FINISHED_EVENTS: Record<string, HistoryEventType> = { complete: 'imported', error: 'failed', cancelled: 'stopped' };

const REMEDY_FULL_KEY = 'This needs SHELFMARK_API_KEY as api_key. It is a root-equivalent key, so keeping the read-only one means going without this.';

const REMEDY_AUTH = 'Shelfmark has authentication on and refused this request. Set api_key to the value of SHELFMARK_API_KEY_READONLY, or SHELFMARK_API_KEY for the version and queue as well.';
const REMEDY_TOO_OLD = 'Shelfmark has no /api/stats before 1.5.0. Upgrade it.';

type RawConfig = { release_version?: unknown };
type RawStats = { errors?: { failed_7d?: unknown } };
type RawTask = { title?: unknown; author?: unknown; status_message?: unknown; format?: unknown; source_display_name?: unknown; added_time?: unknown; retry_available?: unknown };
type RawSnapshot = { status?: Record<string, Record<string, RawTask> | undefined> };
type RawDismissed = { item_type?: unknown; final_status?: unknown; terminal_at?: unknown; source_id?: unknown; snapshot?: { download?: RawTask } };
/** One stopped download. `at` is undefined only for a row Shelfmark gave no time at all. */
type FinishedRow = { taskId: string; status: string; at: string | undefined; task: RawTask };
type RawBook = { provider?: unknown; provider_id?: unknown; title?: unknown; authors?: unknown; publish_year?: unknown };
type RawRelease = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const hashOf = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 32);
/** A failed download's message can quote the address it failed on, indexer key included. */
const ANY_URL = /[a-z][a-z0-9+.-]*:\/\/\S+/gi;
/** Shelfmark's own download route reads the count from either place. */
function downloadsOf(raw: RawRelease): number | undefined {
    const extra = raw.extra;
    const nested = typeof extra === 'object' && extra !== null ? (extra as Record<string, unknown>).downloads : undefined;
    const count = raw.downloads ?? nested;
    return typeof count === 'number' ? count : undefined;
}
const SIZE_UNITS: Record<string, number> = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };
/** Prowlarr's rows give bytes. Direct ones only say `42.2MB`, so this is approximate for those. */
function sizeOf(raw: RawRelease): number | undefined {
    if (typeof raw.size_bytes === 'number') return raw.size_bytes;
    const match = typeof raw.size === 'string' ? /^([\d.]+)\s*(KB|MB|GB)$/i.exec(raw.size.trim()) : null;
    const unit = SIZE_UNITS[match?.[2]?.toUpperCase() ?? ''];
    return match === null || unit === undefined ? undefined : Math.round(Number(match[1]) * unit);
}
const isForbidden = (err: unknown): boolean => err instanceof ServiceError && err.kind === 'AuthFailed' && err.detail.includes('HTTP 403');
/**
 * A hash, never `source_id` itself: on a Prowlarr row that is the indexer's own
 * download URL, API key and all, and a guid is shown to the caller. `source` and
 * `source_id` are what Shelfmark requires to queue a release, so together they
 * name one.
 */
function guidOf(raw: RawRelease): string | undefined {
    const source = str(raw.source);
    const sourceId = str(raw.source_id);
    if (source === undefined || sourceId === undefined) return undefined;
    return `${source}:${hashOf(sourceId)}`;
}

/**
 * Shelfmark's JSON API, written against tag v1.6.1. Three cases of access: no
 * authentication set up, Shelfmark's default, where every route is open and no key
 * is needed; `SHELFMARK_API_KEY_READONLY`, which reaches `/api/stats` and nothing
 * else, so no version, queue, search or grab; and `SHELFMARK_API_KEY`, which reaches
 * everything, including settings that make the server run a script. The writes here
 * queue a release, cancel a download and retry one. Ebooks only: audiobooks are a
 * different `content_type`.
 */
export class ShelfmarkAdapter
    implements ServiceAdapter, HealthCheckCapable, HistoryCapable, QueueCapable, QueueRemoveCapable, RetryCapable, SearchCapable, ReleaseSearchCapable, ReleaseGrabCapable
{
    readonly type: ServiceId = 'shelfmark';
    readonly id = 'shelfmark';
    /** Books, so `diagnose` leaves this queue out of a film's or series' answer. */
    readonly queueKind = 'book';
    readonly grabsFirstReleaseByDefault = true;
    readonly supportsBlocklist = false;
    readonly cancelOnly = true;
    readonly #http: ServiceHttp;
    readonly #public: ServiceHttp;
    /**
     * Set by the first 403 from an admin route, and never tried again: every 403
     * counts toward `ServiceHttp`'s circuit breaker, so asking on each call would
     * trip it on a healthy server. A config change builds a new adapter, so a
     * swapped key starts over.
     */
    #readOnly = false;
    /** Raw rows by book id, oldest first, because a grab has to send one back whole. */
    readonly #listed = new Map<string, { at: number; rows: RawRelease[] }>();

    constructor(config: ConfigByService['shelfmark'], fetchImpl: typeof fetch = fetch) {
        this.#http = new ServiceHttp(this.id, config, config.api_key === undefined ? noAuth : apiKeyHeader('X-Api-Key', config.api_key), fetchImpl);
        // `/api/health` is public, and the read-only key is refused everywhere but `/api/stats`.
        this.#public = new ServiceHttp(this.id, config, noAuth, fetchImpl);
    }

    /**
     * What is still to come or went wrong: `complete` and `cancelled` tasks stay in
     * `/api/status` until cleared, and a finished book is not in a queue. A read-only
     * key cannot see this, and an empty list would claim the queue is empty, so it
     * fails and `get_queue` reports Shelfmark as degraded.
     */
    async getQueue(): Promise<QueueItem[]> {
        if (this.#readOnly) throw new ServiceError('AuthFailed', this.id, 'the read-only key cannot read the queue', { remedy: REMEDY_FULL_KEY });
        let body: Record<string, unknown>;
        try {
            body = await this.#http.get<Record<string, unknown>>(STATUS_PATH);
        } catch (err) {
            if (!isForbidden(err)) throw err;
            this.#readOnly = true;
            throw new ServiceError('AuthFailed', this.id, 'the read-only key cannot read the queue', { remedy: REMEDY_FULL_KEY });
        }
        return QUEUE_STATUSES.flatMap(status => {
            const tasks = body[status];
            if (typeof tasks !== 'object' || tasks === null) return [];
            return Object.entries(tasks as Record<string, RawTask>).map(([id, task]) => this.#queueItem(id, status, task));
        });
    }

    #queueItem(id: string, status: string, task: RawTask): QueueItem {
        const reason = status === 'error' ? this.#fencedReason(task) : undefined;
        return {
            service: this.id,
            // The task id is the release's `source_id`, so the same hash and for the same reason as `guidOf`.
            id: hashOf(id),
            title: this.#fencedTitle(task),
            status,
            ...(reason === undefined ? {} : { errorMessage: reason })
        };
    }

    /** Cancels one queued or active book. `opts` has no effect: Shelfmark has no blocklist and only one way to cancel. */
    async removeQueueItem(id: string, _opts: RemoveQueueOptions): Promise<void> {
        const status = await this.#adminRead<Record<string, Record<string, RawTask> | undefined>>(STATUS_PATH, 'read the queue');
        const taskId = QUEUE_STATUSES.flatMap(bucket => Object.keys(status[bucket] ?? {})).find(key => hashOf(key) === id);
        if (taskId === undefined) throw new ServiceError('NotFound', this.id, `nothing in the queue has id "${id}"`, { remedy: 'It may have finished. Call get_queue for a current list.' });
        await this.#taskWrite(taskId, 'cancel', path => this.#http.delete(`${path}/cancel`));
    }

    /**
     * Failed and cancelled downloads Shelfmark says it can run again. Looked up in
     * the history rather than the queue because the route also takes a row from
     * before a restart, when the queue no longer holds it.
     */
    async findRetryTarget(id: string, opts: { hasPassword: boolean }): Promise<RetryTarget> {
        return this.#retryTargetOf(await this.#retryRow(id, opts.hasPassword), id);
    }

    /** Shelfmark says `queued` only once the download is back in its queue, so there is nothing further to watch for. */
    async runRetry(id: string, _opts: { method: RetryMethod; password?: string }): Promise<RetryOutcome> {
        const row = await this.#retryRow(id, false);
        const answer = await this.#taskWrite(row.taskId, 'retry', path => this.#http.post<{ status?: unknown }>(`${path}/retry`, undefined));
        if (answer.status !== 'queued') throw new ServiceError('UpstreamError', this.id, 'Shelfmark did not say the download was queued again');
        return { target: this.#retryTargetOf(row, id), id, state: 'downloading', status: 'queued' };
    }

    async #retryRow(id: string, hasPassword: boolean): Promise<FinishedRow> {
        if (hasPassword) throw new Error('A Shelfmark download has no archive password to supply. Leave out `password`.');
        const row = (await this.#finished()).find(r => hashOf(r.taskId) === id);
        if (row === undefined) throw new ServiceError('NotFound', this.id, `no failed or cancelled download has id "${id}"`, { remedy: 'Take the id from a get_history or get_queue row for Shelfmark.' });
        if (row.status === 'complete') throw new ServiceError('NotFound', this.id, 'that download finished, so there is nothing to retry');
        if (row.task.retry_available !== true) throw new ServiceError('NotFound', this.id, 'Shelfmark says this download cannot be retried', { remedy: 'Find it again with get_releases and grab it with grab_release.' });
        return row;
    }

    #retryTargetOf(row: FinishedRow, id: string): RetryTarget {
        const reason = row.status === 'error' ? this.#fencedReason(row.task) : undefined;
        return { id, title: this.#fencedTitle(row.task), where: 'history', status: row.status, ...(reason === undefined ? {} : { reason }), method: 'requeue' };
    }

    /**
     * The task id goes in the path and can be an indexer's URL with its key, which
     * `ServiceHttp` would repeat in an error, so every failure here is reworded.
     */
    async #taskWrite<T>(taskId: string, verb: string, write: (path: string) => Promise<T>): Promise<T> {
        const encoded = encodeURIComponent(taskId);
        try {
            return await write(`/api/download/${encoded}`);
        } catch (err) {
            if (!(err instanceof ServiceError)) throw err;
            if (isForbidden(err)) throw new ServiceError('AuthFailed', this.id, `the read-only key cannot ${verb} a download`, { remedy: REMEDY_FULL_KEY });
            if (err.kind === 'NotFound') throw new ServiceError('NotFound', this.id, `Shelfmark no longer has that download in a state it can ${verb}`, { remedy: 'It may just have finished. Call get_queue or get_history for where it stands.' });
            const detail = err.detail.replaceAll(encoded, '[download]');
            throw new ServiceError(err.kind, this.id, detail, err.remedy === undefined ? undefined : { remedy: err.remedy });
        }
    }

    /**
     * Stopped downloads, newest order left to the tool. `id` matches `get_queue`'s and
     * is what `retry_download` takes. `at` is when the download ended only on a row
     * dismissed in Shelfmark: on the others it is when it was queued, the only time
     * Shelfmark gives for them. At most the latest 200 undismissed and 500 dismissed.
     */
    async readHistory(opts: HistoryQuery): Promise<HistoryEntry[]> {
        if (opts.id !== undefined) {
            throw new ServiceError('NotFound', this.id, 'Shelfmark history is not scoped by an id', { remedy: 'Leave out `id`: Shelfmark answers for all its downloads.' });
        }
        return (await this.#finished()).flatMap(row => {
            const event = FINISHED_EVENTS[row.status];
            if (event === undefined || row.at === undefined || (opts.since !== undefined && row.at < opts.since)) return [];
            const format = str(row.task.format);
            const source = str(row.task.source_display_name);
            const reason = event === 'failed' ? this.#fencedReason(row.task) : undefined;
            const entry: HistoryEntry = {
                service: this.id,
                id: hashOf(row.taskId),
                at: row.at,
                event,
                rawEvent: row.status,
                title: this.#fencedTitle(row.task),
                ...(format === undefined ? {} : { quality: format }),
                ...(source === undefined ? {} : { indexer: fenceText(source, { service: this.id, field: 'source_display_name' }) }),
                ...(reason === undefined ? {} : { reason })
            };
            return [entry];
        });
    }

    /** The snapshot leaves out what was dismissed and the history holds nothing else, so a row is in one or the other. */
    async #finished(): Promise<FinishedRow[]> {
        const snapshot = await this.#adminRead<RawSnapshot>(SNAPSHOT_PATH, 'read the download history');
        const dismissed = await this.#adminRead<RawDismissed[]>(DISMISSED_PATH, 'read the download history');
        const rows = new Map<string, FinishedRow>();
        for (const row of dismissed) {
            const task = row.snapshot?.download;
            const taskId = str(row.source_id);
            const status = str(row.final_status);
            if (row.item_type !== 'download' || task === undefined || taskId === undefined || status === undefined) continue;
            const ended = typeof row.terminal_at === 'string' ? new Date(row.terminal_at) : undefined;
            rows.set(taskId, { taskId, status, task, at: ended === undefined || Number.isNaN(ended.getTime()) ? undefined : ended.toISOString() });
        }
        for (const status of Object.keys(FINISHED_EVENTS)) {
            for (const [taskId, task] of Object.entries(snapshot.status?.[status] ?? {})) {
                if (!rows.has(taskId)) rows.set(taskId, { taskId, status, task, at: typeof task.added_time === 'number' ? new Date(task.added_time * 1000).toISOString() : undefined });
            }
        }
        return [...rows.values()];
    }

    /** A read only a full key can make, with the first refusal remembered. */
    async #adminRead<T>(path: string, what: string): Promise<T> {
        const refused = () => new ServiceError('AuthFailed', this.id, `the read-only key cannot ${what}`, { remedy: REMEDY_FULL_KEY });
        if (this.#readOnly) throw refused();
        try {
            return await this.#http.get<T>(path);
        } catch (err) {
            if (!isForbidden(err)) throw err;
            this.#readOnly = true;
            throw refused();
        }
    }

    #fencedTitle(task: RawTask): string {
        const title = str(task.title) ?? 'untitled';
        const author = str(task.author);
        return fenceText(author === undefined ? title : `${title} by ${author}`, { service: this.id, field: 'title' });
    }

    #fencedReason(task: RawTask): string | undefined {
        const message = str(task.status_message);
        return message === undefined ? undefined : fenceText(message.replace(ANY_URL, '[url]'), { service: this.id, field: 'status_message' });
    }

    /** Books not yet owned, so `discover` only. A read-only key cannot search: the first refusal is remembered. */
    async search(query: string, source: SearchSource): Promise<SearchHit[]> {
        if (source !== 'discover' || this.#readOnly) return [];
        let body: { books?: RawBook[] };
        try {
            body = await this.#http.get<{ books?: RawBook[] }>(`${SEARCH_PATH}?${new URLSearchParams({ query, limit: String(SEARCH_LIMIT) }).toString()}`);
        } catch (err) {
            if (!isForbidden(err)) throw err;
            this.#readOnly = true;
            return [];
        }
        return (body.books ?? []).flatMap(book => {
            const provider = str(book.provider);
            const providerId = str(book.provider_id);
            if (provider === undefined || providerId === undefined) return [];
            const authors = Array.isArray(book.authors) ? book.authors.filter((a): a is string => typeof a === 'string') : [];
            const title = str(book.title) ?? 'untitled';
            const hit: SearchHit = {
                service: this.id,
                source,
                kind: 'book',
                id: `${provider}:${providerId}`,
                title: fenceText(authors.length === 0 ? title : `${title} by ${authors.join(', ')}`, { service: this.id, field: 'title' }),
                ids: {},
                ...(typeof book.publish_year === 'number' ? { year: book.publish_year } : {})
            };
            return [hit];
        });
    }

    /**
     * Files on offer for a book, `id` being a `lookup_media` book id. Every source
     * Shelfmark has is searched, which took 24s to 54s against a live v1.6.1, so a recent
     * answer is reused: the preview of a grab asks again straight after a listing.
     * Fields are copied one by one, because a row's `download_url` can hold an
     * indexer's API key. Most downloads first, and a row with no count last: a
     * source that counts nothing says nothing against the file.
     */
    async findReleases(opts: ReleaseScope): Promise<ReleaseCandidate[]> {
        if (opts.season !== undefined || opts.episode !== undefined) throw new Error('`season` and `episode` are for series. A book has neither.');
        if (opts.album !== undefined) throw new Error('`album` is for a Lidarr artist. A book has none.');
        const ranked = [...(await this.#rawReleases(opts.id))].sort((a, b) => (downloadsOf(b) ?? -1) - (downloadsOf(a) ?? -1));
        return ranked.map(raw => {
            const language = str(raw.language);
            const format = str(raw.format);
            const protocol = str(raw.protocol);
            const downloads = downloadsOf(raw);
            const sizeBytes = sizeOf(raw);
            return {
                ...(downloads === undefined ? {} : { downloads }),
                service: this.id,
                guid: guidOf(raw) as string,
                indexerId: NO_INDEXER_ID,
                indexer: fenceText(str(raw.indexer) ?? str(raw.source) ?? 'unknown', { service: this.id, field: 'indexer' }),
                title: fenceText(str(raw.title) ?? 'untitled', { service: this.id, field: 'title' }),
                rejected: false,
                rejections: [],
                ...(sizeBytes === undefined ? {} : { sizeBytes }),
                ...(typeof raw.seeders === 'number' ? { seeders: raw.seeders } : {}),
                ...(format === undefined ? {} : { quality: format }),
                ...(language === undefined ? {} : { language }),
                ...(protocol === undefined ? {} : { protocol })
            };
        });
    }

    /** Shelfmark takes back the whole row it listed, so this needs one from `findReleases`, which a grab's preview has just read. */
    async grabRelease(opts: { guid: string; indexerId: number }): Promise<void> {
        const raw = [...this.#listed.values()].flatMap(l => l.rows).find(r => guidOf(r) === opts.guid);
        if (raw === undefined) {
            throw new ServiceError('NotFound', this.id, 'that release is no longer on offer', { remedy: 'Call get_releases again and grab one from the fresh list.' });
        }
        let answer: { status?: unknown };
        try {
            answer = await this.#http.post<{ status?: unknown }>(DOWNLOAD_PATH, raw);
        } catch (err) {
            if (isForbidden(err)) throw new ServiceError('AuthFailed', this.id, 'the read-only key cannot download', { remedy: REMEDY_FULL_KEY });
            throw err;
        }
        if (answer.status !== 'queued') throw new ServiceError('UpstreamError', this.id, 'Shelfmark did not say the release was queued');
    }

    async #rawReleases(id: string): Promise<RawRelease[]> {
        const separator = id.indexOf(':');
        if (separator <= 0 || separator === id.length - 1) {
            throw new ServiceError('NotFound', this.id, `"${id}" is not a book id`, { remedy: 'Take the id from a lookup_media row whose kind is book, such as googlebooks:5neBQgAACAAJ.' });
        }
        const listed = this.#listed.get(id);
        if (listed !== undefined && Date.now() - listed.at < RELEASES_FRESH_MS) return listed.rows;
        if (this.#readOnly) throw new ServiceError('AuthFailed', this.id, 'the read-only key cannot search for releases', { remedy: REMEDY_FULL_KEY });
        const query = new URLSearchParams({ provider: id.slice(0, separator), book_id: id.slice(separator + 1), content_type: 'ebook' });
        let body: { releases?: unknown };
        try {
            body = await this.#http.get<{ releases?: unknown }>(`${RELEASES_PATH}?${query.toString()}`, { timeoutMs: RELEASE_SEARCH_TIMEOUT_MS, retry: false });
        } catch (err) {
            if (!isForbidden(err)) throw err;
            this.#readOnly = true;
            throw new ServiceError('AuthFailed', this.id, 'the read-only key cannot search for releases', { remedy: REMEDY_FULL_KEY });
        }
        const rows = (Array.isArray(body.releases) ? (body.releases as unknown[]) : []).filter((r): r is RawRelease => typeof r === 'object' && r !== null && guidOf(r as RawRelease) !== undefined);
        this.#listed.delete(id);
        this.#listed.set(id, { at: Date.now(), rows });
        // A Map keeps insertion order, so the first key is the oldest listing.
        if (this.#listed.size > LISTINGS_KEPT) this.#listed.delete(this.#listed.keys().next().value as string);
        return rows;
    }

    async getVersion(): Promise<string> {
        const version = await this.#readVersion();
        if (version === undefined) throw new ServiceError('UpstreamError', this.id, 'the version needs the admin key, and a build without RELEASE_VERSION reports none');
        return version;
    }

    /** `/api/health` needs no key, so it alone would pass a wrong one. `/api/stats` takes either key. */
    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, this.type, async () => {
            await this.#stats();
            return this.#readVersion();
        });
    }

    async getFailedHealthChecks(): Promise<HealthCheck[]> {
        const [coordinatorUp, stats] = await Promise.all([this.#coordinatorUp(), this.#stats()]);
        const check = (source: string, type: string, message: string): HealthCheck => ({ service: this.id, source, type, message });
        const out: HealthCheck[] = [];
        if (!coordinatorUp) out.push(check('coordinator', 'error', 'Shelfmark is up but its download coordinator is stopped, so nothing downloads'));
        const failed = stats.errors?.failed_7d;
        if (typeof failed === 'number' && failed > 0) out.push(check('downloads', 'warning', `${failed} download(s) failed in the last 7 days`));
        return out;
    }

    /** Undefined for a read-only key, and for a build with no release version set: Shelfmark reports `N/A`. */
    async #readVersion(): Promise<string | undefined> {
        if (this.#readOnly) return undefined;
        let body: RawConfig;
        try {
            body = await this.#http.get<RawConfig>(CONFIG_PATH);
        } catch (err) {
            if (!isForbidden(err)) throw err;
            this.#readOnly = true;
            return undefined;
        }
        const version = body.release_version;
        return typeof version === 'string' && version !== '' && version !== 'N/A' ? version : undefined;
    }

    async #stats(): Promise<RawStats> {
        try {
            return await this.#http.get<RawStats>(STATS_PATH);
        } catch (err) {
            if (err instanceof ServiceError && err.kind === 'AuthFailed') throw new ServiceError('AuthFailed', this.id, err.detail, { remedy: REMEDY_AUTH });
            if (err instanceof ServiceError && err.kind === 'NotFound') throw new ServiceError('VersionUnsupported', this.id, err.detail, { remedy: REMEDY_TOO_OLD });
            throw err;
        }
    }

    /** A stopped coordinator answers 503, which is a finding here rather than a failed read. */
    async #coordinatorUp(): Promise<boolean> {
        try {
            await this.#public.get<unknown>(HEALTH_PATH);
            return true;
        } catch (err) {
            if (err instanceof ServiceError && err.kind === 'UpstreamError' && err.detail.includes('HTTP 503')) return false;
            throw err;
        }
    }
}
