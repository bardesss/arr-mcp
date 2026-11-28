import type { ConfigByService, ServiceId } from '../config/schema.ts';
import { apiKeyHeader } from '../core/auth.ts';
import { SHORT_READ_TTL_MS, cached } from '../core/cache.ts';
import { ServiceError } from '../core/errors.ts';
import { fenceText, fencer } from '../core/fence.ts';
import { isoInstant, newestFirst } from '../core/instant.ts';
import { logger } from '../core/logger.ts';
import { ServiceHttp } from '../core/http.ts';
import {
    diagnoseConnection,
    type AutomationJob,
    type AutomationOverview,
    type ConnectionDiagnosis,
    type HealthCheck,
    type HealthCheckCapable,
    type HistoryCapable,
    type HistoryEntry,
    type HistoryQuery,
    type RequestAutomationCapable,
    type RequestOrigin,
    type ServiceAdapter,
    type Window
} from './types.ts';

const KEY_REMEDY = 'The API key is wrong or revoked. Create one in SuggestArr under Profile → API keys, signed in as an administrator.';

type Page<T> = { data?: T[]; meta?: { pages?: number; total?: number } };
type RawMe = { data?: { role?: string } };
type RawHealth = { status?: string; arr?: Record<string, string>; [component: string]: unknown };
type RawJob = {
    id?: number;
    name?: string;
    job_type?: string;
    enabled?: boolean;
    media_type?: string;
    schedule_value?: string;
    max_results?: number;
    max_requests_per_user?: number;
    request_limit_window_hours?: number;
    filters?: { max_similar_movie?: number; max_similar_tv?: number };
};
type RawRun = { job_id?: number; status?: string; started_at?: string | null; requested_count?: number; error_message?: string | null };
export type RawRequest = {
    tmdb_id?: string;
    media_type?: string;
    title?: string | null;
    source_media_id?: string | null;
    requested_at?: string | null;
};
type RawCounts = { total?: number; today?: number; this_week?: number; this_month?: number };
type RawInstallation = { data?: { queue?: { failed?: number } } };

/** SuggestArr's tags for a request no watched title prompted (`request_sources.py`); `0` is an LLM pick. */
const TAGGED: Record<string, RequestOrigin['reason']> = {
    '': 'discover',
    discover: 'discover',
    list_import: 'list_import',
    trakt_recommendations: 'trakt',
    ai_search: 'ai',
    '0': 'ai'
};
const REASON_TEXT: Record<RequestOrigin['reason'], string> = {
    similar: 'similar to a watched title',
    discover: 'from a Discover job',
    list_import: 'from an imported list',
    trakt: 'from Trakt recommendations',
    ai: 'picked by its AI recommender',
    unknown: 'for a reason it did not record'
};
/** `/api/health` components that are fine; any other value is a fault. */
const FINE = new Set(['ok', 'not_configured']);

const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const READ_TTL_MS = 30_000;

const kindOf = (v: string | undefined): 'movie' | 'tv' | undefined => (v === 'movie' || v === 'tv' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** `similar` with the watched title's TMDB id, or the job type's tag. */
export function originOf(source: string | null | undefined): Pick<RequestOrigin, 'reason' | 'sourceTmdbId'> {
    const tag = source ?? '';
    const tagged = TAGGED[tag];
    if (tagged !== undefined) return { reason: tagged };
    return /^\d+$/.test(tag) ? { reason: 'similar', sourceTmdbId: Number(tag) } : { reason: 'unknown' };
}

/** One sentence for the request step of diagnose_media. */
export function originSentence(o: RequestOrigin): string {
    const when = o.requestedAt === '' ? '' : ` on ${o.requestedAt.slice(0, 10)}`;
    const source = o.sourceTmdbId === undefined ? '' : ` (TMDB ${o.sourceTmdbId})`;
    return `${o.service} requested it${when}, ${REASON_TEXT[o.reason]}${source}.`;
}

/**
 * SuggestArr's public `/api/v1`, checked live on v3.5.0, plus `/api/health`,
 * which needs no key. Read only: the key belongs to a user and can approve
 * suggestions and start runs, and arr-mcp sends only GETs with it.
 *
 * Single instance: one SuggestArr files one stack's automated requests.
 */
export class SuggestarrAdapter implements ServiceAdapter, HealthCheckCapable, HistoryCapable, RequestAutomationCapable {
    readonly type: ServiceId = 'suggestarr';
    readonly id = 'suggestarr';
    readonly #http: ServiceHttp;
    readonly #me = cached(SHORT_READ_TTL_MS, () => this.#http.get<RawMe>('/api/v1/me'));
    readonly #jobs = cached(SHORT_READ_TTL_MS, () => this.#all<RawJob>('/api/v1/jobs'));
    readonly #runs = cached(SHORT_READ_TTL_MS, () => this.#http.get<Page<RawRun>>('/api/v1/runs?per_page=50'));
    /** Newest first. One read serves every title a diagnose_media or a get_history looks up. */
    readonly #requests = cached(READ_TTL_MS, () => this.#all<RawRequest>('/api/v1/requests?sort=date_desc'));

    constructor(config: ConfigByService['suggestarr'], fetchImpl: typeof fetch = fetch) {
        this.#http = new ServiceHttp(this.id, config, { ...apiKeyHeader('X-Api-Key', config.api_key), remedy: KEY_REMEDY }, fetchImpl);
    }

    /** SuggestArr's API reports no version: it is compiled into the web UI only. */
    getVersion(): Promise<string> {
        return Promise.reject(new ServiceError('UpstreamError', this.id, 'SuggestArr’s API does not report its version'));
    }

    /** `/api/v1/status` and `/api/health` take no key, so they alone would pass a wrong one. */
    async testConnection(): Promise<ConnectionDiagnosis> {
        this.#me.clear();
        return diagnoseConnection(this.id, this.type, async () => {
            await this.#me();
            return undefined;
        });
    }

    async getFailedHealthChecks(): Promise<HealthCheck[]> {
        const check = (source: string, type: string, message: string): HealthCheck => ({ service: this.id, source, type, message });
        const fence = (v: string) => fenceText(v, { service: this.id, field: 'message' });
        const [health, jobs, runs, me] = await Promise.all([this.#http.get<RawHealth>('/api/health'), this.#jobs(), this.#runs(), this.#me()]);
        const out: HealthCheck[] = [];

        const components: [string, unknown][] = [
            ...Object.entries(health).filter(([k]) => k !== 'status' && k !== 'arr'),
            ...Object.entries(health.arr ?? {})
        ];
        for (const [name, state] of components) {
            if (typeof state === 'string' && !FINE.has(state)) out.push(check(name, 'error', fence(`SuggestArr reports ${name} as ${state}`)));
        }

        if (jobs.items.length > 0 && !jobs.items.some(j => j.enabled === true)) {
            out.push(check('jobs', 'warning', 'Every SuggestArr job is disabled, so nothing is requested automatically'));
        }
        for (const job of jobs.items) {
            const last = (runs.data ?? []).find(r => r.job_id === job.id);
            if (last?.status === 'failed') {
                const why = last.error_message ? `: ${last.error_message}` : '';
                out.push(check('runs', 'error', fence(`The last run of ${job.name ?? `job ${job.id}`} failed${why}`)));
            }
        }

        // Administrator only: any other key is answered 403.
        if (me.data?.role === 'admin') {
            const failed = num((await this.#http.get<RawInstallation>('/api/v1/installation/stats')).data?.queue?.failed);
            if (failed !== undefined && failed > 0) out.push(check('queue', 'warning', `${failed} suggestion(s) could not be filed in Seerr`));
        }
        return out;
    }

    async readAutomationOverview(): Promise<AutomationOverview> {
        const [jobs, runs, counts] = await Promise.all([this.#jobs(), this.#runs(), this.#http.get<{ data?: RawCounts }>('/api/v1/requests/stats')]);
        const c = counts.data;
        return {
            service: this.id,
            jobs: jobs.items.map(j => this.#jobOf(j, (runs.data ?? []).find(r => r.job_id === j.id))),
            ...(c === undefined
                ? {}
                : { requests: { today: c.today ?? 0, thisWeek: c.this_week ?? 0, thisMonth: c.this_month ?? 0, total: c.total ?? 0 } })
        };
    }

    async readRequestOrigin(kind: 'movie' | 'series', tmdbId: number): Promise<RequestOrigin | undefined> {
        const mediaType = kind === 'series' ? 'tv' : 'movie';
        // Newest first, so the first match is the latest request.
        const row = (await this.#requests()).items.find(r => r.media_type === mediaType && r.tmdb_id === String(tmdbId));
        return row === undefined ? undefined : { service: this.id, requestedAt: isoInstant(row.requested_at ?? undefined) ?? '', ...originOf(row.source_media_id) };
    }

    async readHistory(opts: HistoryQuery): Promise<Window<HistoryEntry>> {
        if (opts.id !== undefined) {
            throw new ServiceError('NotFound', this.id, 'SuggestArr history is not scoped by an id', {
                remedy: 'Leave out `id`: SuggestArr lists every request it filed, and diagnose_media says why one title was requested.'
            });
        }
        if (opts.eventType !== undefined && opts.eventType !== 'requested') return { items: [], total: 0 };
        const since = opts.since === undefined ? undefined : Date.parse(opts.since);
        const fence = fencer(this.id);
        const items = (await this.#requests()).items
            .map((r, i): HistoryEntry => {
                const origin = originOf(r.source_media_id);
                const tmdb = Number(r.tmdb_id);
                return {
                    service: this.id,
                    id: `${r.media_type ?? ''}:${r.tmdb_id ?? i}`,
                    at: isoInstant(r.requested_at ?? undefined) ?? '',
                    event: 'requested',
                    rawEvent: 'request',
                    title: fence(r.title ?? '', 'title'),
                    ...(Number.isInteger(tmdb) && kindOf(r.media_type) !== undefined ? { externalIds: { tmdb } } : {}),
                    reason: `${REASON_TEXT[origin.reason]}${origin.sourceTmdbId === undefined ? '' : ` (TMDB ${origin.sourceTmdbId})`}`
                };
            })
            .filter(e => since === undefined || Date.parse(e.at) >= since)
            .sort(newestFirst);
        return { items, total: items.length };
    }

    #jobOf(j: RawJob, last: RawRun | undefined): AutomationJob {
        const perUser = num(j.max_requests_per_user);
        return {
            id: String(j.id ?? ''),
            name: fenceText(j.name ?? '', { service: this.id, field: 'job' }),
            type: j.job_type ?? '',
            enabled: j.enabled === true,
            schedule: j.schedule_value ?? '',
            mediaType: j.media_type ?? '',
            ...(num(j.max_results) === undefined ? {} : { maxResults: j.max_results as number }),
            ...(num(j.filters?.max_similar_movie) === undefined ? {} : { maxSimilarMovie: j.filters?.max_similar_movie as number }),
            ...(num(j.filters?.max_similar_tv) === undefined ? {} : { maxSimilarTv: j.filters?.max_similar_tv as number }),
            // Zero turns the per-user guardrail off.
            ...(perUser === undefined || perUser === 0 ? {} : { maxRequestsPerUser: perUser, requestLimitWindowHours: num(j.request_limit_window_hours) ?? 24 }),
            ...(last === undefined
                ? {}
                : {
                      lastRun: {
                          status: last.status ?? '',
                          at: last.started_at ?? '',
                          requested: last.requested_count ?? 0,
                          ...(last.error_message ? { error: fenceText(last.error_message, { service: this.id, field: 'error' }) } : {})
                      }
                  })
        };
    }

    /** Every page up to `MAX_PAGES`; past that the oldest rows are left unread, and logged. */
    async #all<T>(path: string): Promise<{ items: T[] }> {
        const join = path.includes('?') ? '&' : '?';
        const items: T[] = [];
        for (let page = 1; page <= MAX_PAGES; page += 1) {
            const body = await this.#http.get<Page<T>>(`${path}${join}page=${page}&per_page=${PAGE_SIZE}`);
            items.push(...(body.data ?? []));
            if (page >= (body.meta?.pages ?? 1) || (body.data ?? []).length === 0) return { items };
        }
        logger.warn({ service: this.id, path, read: items.length }, 'list over the page cap; the rest is not read');
        return { items };
    }
}
