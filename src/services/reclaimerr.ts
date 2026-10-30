import type { ConfigByService, ServiceId } from '../config/schema.ts';
import { apiKeyHeader } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { fenceText } from '../core/fence.ts';
import { ServiceHttp } from '../core/http.ts';
import {
    diagnoseConnection,
    type CleanupCandidate,
    type CleanupCapable,
    type CleanupOverview,
    type CleanupProtection,
    type CleanupRemoval,
    type CleanupRule,
    type CleanupState,
    type CleanupStatus,
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

export const RECLAIMERR_API = '/api/v1';

export const TESTED_MINOR = '0.6';

/** What arr-mcp reads. Every one is a read scope: the adapter never writes. */
export const NEEDED_SCOPES = ['system:read', 'candidates:read', 'rules:read', 'events:read', 'protections:read'] as const;
type Scope = (typeof NEEDED_SCOPES)[number];
const WRITE_SCOPES = ['candidates:manage', 'protections:manage', 'tasks:run'];
const SCOPES_REMEDY = `Create a token in Reclaimerr's Settings → Integrations with ${NEEDED_SCOPES.join(', ')} and nothing else.`;

type RawDiscovery = { granted_scopes?: string[] };
type RawSystem = {
    status?: string;
    version?: string;
    has_main_media_server?: boolean;
    last_media_sync_at?: string | null;
    last_candidate_scan_at?: string | null;
};
type RawStats = {
    candidates_total?: number;
    reclaimable_bytes?: number;
    reclaimed_bytes_total?: number;
    reclaimed_items_total?: number;
    next_auto_delete_at?: string | null;
    auto_delete_task_enabled?: boolean;
};
type RawPage<T> = { items?: T[]; total?: number; total_pages?: number };
type RawRule = { id?: number; name?: string; media_type?: string; target_scope?: string; outcome?: string; enabled?: boolean };
export type RawCandidate = {
    id?: number;
    media_type?: string;
    scope?: string;
    season_number?: number | null;
    episode_number?: number | null;
    title?: string;
    year?: number | null;
    tmdb_id?: number | null;
    matched_rule_ids?: number[];
    reason?: string | null;
    delete_operation?: string;
    auto_delete_state?: string;
    auto_delete_eligible_at?: string | null;
    auto_delete_postponed_until?: string | null;
    blockers?: string[] | null;
    delete_attempts?: number | null;
    last_delete_error?: string | null;
    lifecycle_reason?: string | null;
};
type RawProtection = {
    media_type?: string;
    scope?: string;
    title?: string;
    tmdb_id?: number | null;
    season_number?: number | null;
    episode_number?: number | null;
    permanent?: boolean;
    expires_at?: string | null;
    reason?: string | null;
    active?: boolean;
};
type RawEvent = {
    id?: string;
    type?: string;
    occurred_at?: string;
    candidate_id?: number | null;
    payload?: { candidate?: RawCandidate; protection?: RawProtection; reason?: string | null };
};
type RawEventPage = { items?: RawEvent[]; next_cursor?: string | null; has_more?: boolean };

const EVENT: Record<string, HistoryEventType> = {
    'candidate.deleted': 'deleted',
    'candidate.moved': 'deleted',
    'candidate.scheduled': 'scheduled',
    'candidate.protected': 'protected',
    'protection.created': 'protected'
};
const EMITTED = new Set<HistoryEventType>(['deleted', 'scheduled', 'protected', 'unknown']);
const REMOVED = ['candidate.deleted', 'candidate.moved'];
const STATES = new Set<CleanupState>(['disabled', 'scheduled', 'eligible', 'postponed', 'canceled']);
/** Soonest to go first; held-back ones last. */
const STATE_ORDER: Record<CleanupState, number> = { eligible: 0, scheduled: 1, postponed: 2, disabled: 3, canceled: 4 };

const PAGE_SIZE = 200;
const MAX_PAGES = 25;
/** The feed is oldest-first, so the newest rows are found by widening a window back from now. */
const HISTORY_WINDOWS_DAYS = [7, 30, 180, 730];
const REMOVAL_WINDOW_DAYS = 365;
const SCOPES_TTL_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

const kindOf = (v: string | undefined): 'movie' | 'series' => (v === 'series' ? 'series' : 'movie');
const num = (v: number | null | undefined): number | undefined => (typeof v === 'number' ? v : undefined);
const text = (v: string | null | undefined): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const daysAgo = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString();

/**
 * Reclaimerr's `/api/v1`, the versioned external API with scoped bearer
 * tokens, checked live on 0.6.5. Read only: every call needs a `:read` scope,
 * and the scopes are read first so a missing one is reported rather than
 * answered with a 403 that would count against the circuit breaker.
 */
export class ReclaimerrAdapter implements ServiceAdapter, HealthCheckCapable, HistoryCapable, CleanupCapable {
    readonly type: ServiceId = 'reclaimerr';
    readonly id = 'reclaimerr';
    readonly #http: ServiceHttp;
    #scopes: { at: number; value: Promise<Set<string>> } | undefined;
    #rules: { at: number; value: Promise<Map<number, RawRule>> } | undefined;

    constructor(config: ConfigByService['reclaimerr'], fetchImpl: typeof fetch = fetch) {
        this.#http = new ServiceHttp(this.id, config, apiKeyHeader('Authorization', `Bearer ${config.api_key}`), fetchImpl);
    }

    async getVersion(): Promise<string> {
        await this.#need('system:read');
        const system = await this.#http.get<RawSystem>(`${RECLAIMERR_API}/system`);
        if (!system.version) throw new ServiceError('UpstreamError', this.id, 'system returned no version field');
        return system.version;
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, this.type, () => this.getVersion());
    }

    async getFailedHealthChecks(): Promise<HealthCheck[]> {
        const scopes = await this.#grantedScopes();
        const check = (source: string, type: string, message: string): HealthCheck => ({ service: this.id, source, type, message });
        const fence = (value: string) => fenceText(value, { service: this.id, field: 'message' });
        const out: HealthCheck[] = [];

        const missing = NEEDED_SCOPES.filter(s => !scopes.has(s));
        if (missing.length > 0) {
            out.push(check('token', 'warning', `The API token lacks ${missing.join(', ')}, so arr-mcp cannot read everything it uses. ${SCOPES_REMEDY}`));
        }
        const writes = WRITE_SCOPES.filter(s => scopes.has(s));
        if (writes.length > 0) {
            out.push(check('token', 'warning', `The API token also grants ${writes.join(', ')}. arr-mcp only reads, so a token without them is enough.`));
        }

        if (scopes.has('system:read')) {
            const system = await this.#http.get<RawSystem>(`${RECLAIMERR_API}/system`);
            if (system.status !== undefined && system.status !== 'ok') out.push(check('system', 'error', fence(`Reclaimerr reports status ${system.status}`)));
            if (system.has_main_media_server === false) {
                out.push(check('system', 'warning', 'No main media server is set in Reclaimerr, so rules based on watch history cannot match'));
            }
            const actual = system.version === undefined ? undefined : parseVersion(system.version);
            const tested = parseVersion(TESTED_MINOR);
            if (actual !== undefined && tested !== undefined && compareVersions(actual.slice(0, 2), tested) > 0) {
                out.push(check('version', 'warning', `Reclaimerr ${system.version} is newer than ${TESTED_MINOR}.x, which this adapter was written against; untested, results may be wrong`));
            }
        }

        if (scopes.has('candidates:read')) {
            const candidates = await this.#candidates();
            for (const c of candidates) {
                const error = text(c.last_delete_error);
                if (error !== undefined) {
                    const tries = num(c.delete_attempts);
                    out.push(check('candidates', 'error', fence(`Could not ${c.delete_operation === 'move' ? 'move' : 'delete'} ${c.title ?? 'an item'}${tries === undefined ? '' : ` after ${tries} attempt(s)`}: ${error}`)));
                }
            }
        }
        return out;
    }

    async readCleanupOverview(want: number): Promise<CleanupOverview> {
        const scopes = await this.#grantedScopes();
        const [stats, rules, candidates, protections] = await Promise.all([
            scopes.has('system:read') ? this.#http.get<RawStats>(`${RECLAIMERR_API}/stats`) : undefined,
            scopes.has('rules:read') ? this.#ruleMap() : undefined,
            scopes.has('candidates:read') ? this.#candidates() : undefined,
            scopes.has('protections:read') ? this.#readAll<RawProtection>(`${RECLAIMERR_API}/protections?active_only=true`) : undefined
        ]);
        const sorted = candidates?.map(c => this.#candidateOf(c, rules)).sort(soonestFirst);
        return {
            service: this.id,
            ...(stats === undefined
                ? {}
                : {
                      autoDelete: {
                          enabled: stats.auto_delete_task_enabled === true,
                          ...(text(stats.next_auto_delete_at) === undefined ? {} : { nextAt: utc(stats.next_auto_delete_at) })
                      },
                      totals: {
                          candidates: stats.candidates_total ?? 0,
                          reclaimableBytes: stats.reclaimable_bytes ?? 0,
                          reclaimedBytes: stats.reclaimed_bytes_total ?? 0,
                          reclaimedItems: stats.reclaimed_items_total ?? 0
                      }
                  }),
            ...(rules === undefined ? {} : { rules: [...rules.values()].map(r => this.#ruleOf(r)) }),
            ...(sorted === undefined ? {} : { candidates: { items: sorted.slice(0, Math.max(0, want)), total: sorted.length } }),
            ...(protections === undefined ? {} : { protections: protections.length })
        };
    }

    async readCleanupStatus(kind: 'movie' | 'series', tmdbId: number): Promise<CleanupStatus> {
        const scopes = await this.#grantedScopes();
        const rules = scopes.has('rules:read') ? this.#ruleMap() : Promise.resolve(undefined);
        const [candidates, protections, removals] = await Promise.all([
            scopes.has('candidates:read') ? this.#readAll<RawCandidate>(`${RECLAIMERR_API}/candidates?media_type=${kind}&tmdb_id=${tmdbId}`) : [],
            // No tmdb filter on protections, and there are few: read them all.
            scopes.has('protections:read') ? this.#readAll<RawProtection>(`${RECLAIMERR_API}/protections?media_type=${kind}&active_only=true`) : [],
            scopes.has('events:read') ? this.#removals(daysAgo(REMOVAL_WINDOW_DAYS)) : []
        ]);
        const ruleMap = await rules;
        return {
            service: this.id,
            candidates: candidates.map(c => this.#candidateOf(c, ruleMap)).sort(soonestFirst),
            protections: protections.filter(p => p.tmdb_id === tmdbId).map(p => this.#protectionOf(p)),
            removals: removals
                .filter(e => e.payload?.candidate?.tmdb_id === tmdbId && kindOf(e.payload.candidate.media_type) === kind)
                .map(e => this.#removalOf(e, ruleMap))
                .sort((a, b) => b.at.localeCompare(a.at))
        };
    }

    async readHistory(opts: HistoryQuery): Promise<Window<HistoryEntry>> {
        if (opts.id !== undefined) {
            throw new ServiceError('NotFound', this.id, 'Reclaimerr history is not scoped by a movie or series id', {
                remedy: 'Leave out `id`: Reclaimerr answers for the whole library, and get_media_details shows one title’s cleanup state.'
            });
        }
        if (opts.eventType !== undefined && !EMITTED.has(opts.eventType)) return { items: [], total: 0 };
        await this.#need('events:read');
        const rules = (await this.#grantedScopes()).has('rules:read') ? await this.#ruleMap() : undefined;
        const keep = (e: HistoryEntry) => opts.eventType === undefined || e.event === opts.eventType;

        // A `since` is one window; without it the window widens until it holds what was asked for.
        const windows = opts.since === undefined ? HISTORY_WINDOWS_DAYS.map(daysAgo) : [opts.since];
        let items: HistoryEntry[] = [];
        for (const [i, after] of windows.entries()) {
            const { events } = await this.#events({ after });
            items = events.map(e => this.#entryOf(e, rules)).filter(keep);
            const last = i === windows.length - 1;
            if (last || opts.want === undefined || items.length >= opts.want) break;
        }
        items.sort((a, b) => b.at.localeCompare(a.at));
        return { items, total: items.length };
    }

    #entryOf(e: RawEvent, rules: Map<number, RawRule> | undefined): HistoryEntry {
        const fence = (value: string, field: string) => fenceText(value, { service: this.id, field });
        const c = e.payload?.candidate;
        const p = e.payload?.protection;
        const reasons = [text(c?.lifecycle_reason) ?? text(e.payload?.reason ?? undefined), text(c?.reason), text(p?.reason)].filter(
            (r): r is string => r !== undefined
        );
        // Raw names: the whole reason is fenced once below.
        const named = (c?.matched_rule_ids ?? []).map(id => rules?.get(id)?.name ?? `#${id}`);
        return {
            service: this.id,
            id: e.id ?? '',
            at: utc(e.occurred_at),
            event: EVENT[e.type ?? ''] ?? 'unknown',
            rawEvent: e.type ?? '',
            title: fence(c?.title ?? p?.title ?? '', 'title'),
            ...(reasons.length === 0 && named.length === 0
                ? {}
                : { reason: fence([...(named.length === 0 ? [] : [`rule ${named.join(', ')}`]), ...reasons].join('; '), 'reason') })
        };
    }

    #candidateOf(c: RawCandidate, rules: Map<number, RawRule> | undefined): CleanupCandidate {
        const fence = (value: string, field: string) => fenceText(value, { service: this.id, field });
        const state = STATES.has(c.auto_delete_state as CleanupState) ? (c.auto_delete_state as CleanupState) : 'disabled';
        const blockers = (c.blockers ?? []).filter(b => b !== '').map(b => fence(b, 'blocker'));
        return {
            id: String(c.id ?? ''),
            kind: kindOf(c.media_type),
            scope: c.scope ?? kindOf(c.media_type),
            title: fence(c.title ?? '', 'title'),
            ...optionalNum('year', c.year),
            ...optionalNum('tmdbId', c.tmdb_id),
            ...optionalNum('seasonNumber', c.season_number),
            ...optionalNum('episodeNumber', c.episode_number),
            rules: this.#ruleNames(c.matched_rule_ids, rules),
            ...(text(c.reason) === undefined ? {} : { reason: fence(c.reason as string, 'reason') }),
            operation: c.delete_operation === 'move' ? 'move' : 'delete',
            state,
            ...(text(c.auto_delete_eligible_at) === undefined ? {} : { eligibleAt: utc(c.auto_delete_eligible_at) }),
            ...(text(c.auto_delete_postponed_until) === undefined ? {} : { postponedUntil: utc(c.auto_delete_postponed_until) }),
            ...(blockers.length === 0 ? {} : { blockers }),
            ...(num(c.delete_attempts) === undefined || c.delete_attempts === 0 ? {} : { deleteAttempts: c.delete_attempts as number }),
            ...(text(c.last_delete_error) === undefined ? {} : { lastDeleteError: fence(c.last_delete_error as string, 'error') })
        };
    }

    #protectionOf(p: RawProtection): CleanupProtection {
        const fence = (value: string, field: string) => fenceText(value, { service: this.id, field });
        return {
            kind: kindOf(p.media_type),
            scope: p.scope ?? kindOf(p.media_type),
            title: fence(p.title ?? '', 'title'),
            ...optionalNum('tmdbId', p.tmdb_id),
            ...optionalNum('seasonNumber', p.season_number),
            ...optionalNum('episodeNumber', p.episode_number),
            permanent: p.permanent === true,
            ...(text(p.expires_at) === undefined ? {} : { expiresAt: utc(p.expires_at) }),
            ...(text(p.reason) === undefined ? {} : { reason: fence(p.reason as string, 'reason') })
        };
    }

    #removalOf(e: RawEvent, rules: Map<number, RawRule> | undefined): CleanupRemoval {
        const c = e.payload?.candidate ?? {};
        const fence = (value: string, field: string) => fenceText(value, { service: this.id, field });
        return {
            at: utc(e.occurred_at),
            kind: kindOf(c.media_type),
            scope: c.scope ?? kindOf(c.media_type),
            title: fence(c.title ?? '', 'title'),
            ...optionalNum('tmdbId', c.tmdb_id),
            ...optionalNum('seasonNumber', c.season_number),
            ...optionalNum('episodeNumber', c.episode_number),
            operation: e.type === 'candidate.moved' ? 'move' : 'delete',
            rules: this.#ruleNames(c.matched_rule_ids, rules),
            ...(text(c.reason) === undefined ? {} : { reason: fence(c.reason as string, 'reason') })
        };
    }

    #ruleOf(r: RawRule): CleanupRule {
        return {
            id: String(r.id ?? ''),
            name: fenceText(r.name ?? '', { service: this.id, field: 'rule' }),
            kind: r.media_type ?? '',
            outcome: r.outcome ?? '',
            enabled: r.enabled === true
        };
    }

    /** A rule deleted since keeps its id in the candidate but loses its name. */
    #ruleNames(ids: number[] | undefined, rules: Map<number, RawRule> | undefined): string[] {
        return (ids ?? []).map(id => {
            const name = rules?.get(id)?.name;
            return name === undefined ? `#${id}` : fenceText(name, { service: this.id, field: 'rule' });
        });
    }

    async #removals(after: string): Promise<RawEvent[]> {
        const reads = await Promise.all(REMOVED.map(type => this.#events({ after, type })));
        return reads.flatMap(r => r.events);
    }

    /** Oldest first, as the feed serves it. Stops at `MAX_PAGES`, which `capped` reports. */
    async #events(opts: { after: string; type?: string }): Promise<{ events: RawEvent[]; capped: boolean }> {
        const events: RawEvent[] = [];
        let cursor: string | undefined;
        for (let page = 1; page <= MAX_PAGES; page += 1) {
            const query = [
                `limit=${PAGE_SIZE}`,
                `occurred_after=${encodeURIComponent(opts.after)}`,
                ...(opts.type === undefined ? [] : [`event_type=${encodeURIComponent(opts.type)}`]),
                ...(cursor === undefined ? [] : [`cursor=${encodeURIComponent(cursor)}`])
            ];
            const body = await this.#http.get<RawEventPage>(`${RECLAIMERR_API}/events?${query.join('&')}`);
            events.push(...(body.items ?? []));
            if (body.has_more !== true || !body.next_cursor || (body.items ?? []).length === 0) return { events, capped: false };
            cursor = body.next_cursor;
        }
        return { events, capped: true };
    }

    async #candidates(): Promise<RawCandidate[]> {
        return this.#readAll<RawCandidate>(`${RECLAIMERR_API}/candidates`);
    }

    async #readAll<T>(path: string): Promise<T[]> {
        const out: T[] = [];
        const join = path.includes('?') ? '&' : '?';
        for (let page = 1; page <= MAX_PAGES; page += 1) {
            const body = await this.#http.get<RawPage<T>>(`${path}${join}page=${page}&per_page=${PAGE_SIZE}`);
            out.push(...(body.items ?? []));
            const pages = Number.isFinite(body.total_pages) ? (body.total_pages as number) : 1;
            if (page >= pages || (body.items ?? []).length === 0) break;
        }
        return out;
    }

    async #ruleMap(): Promise<Map<number, RawRule>> {
        if (this.#rules === undefined || Date.now() - this.#rules.at > SCOPES_TTL_MS) {
            const value = this.#http
                .get<{ items?: RawRule[] }>(`${RECLAIMERR_API}/rules`)
                .then(body => new Map((body.items ?? []).filter(r => typeof r.id === 'number').map(r => [r.id as number, r])));
            value.catch(() => {
                this.#rules = undefined;
            });
            this.#rules = { at: Date.now(), value };
        }
        return this.#rules.value;
    }

    async #grantedScopes(): Promise<Set<string>> {
        if (this.#scopes === undefined || Date.now() - this.#scopes.at > SCOPES_TTL_MS) {
            const value = this.#http.get<RawDiscovery>(RECLAIMERR_API).then(body => new Set(body.granted_scopes ?? []));
            value.catch(() => {
                this.#scopes = undefined;
            });
            this.#scopes = { at: Date.now(), value };
        }
        return this.#scopes.value;
    }

    async #need(scope: Scope): Promise<void> {
        if ((await this.#grantedScopes()).has(scope)) return;
        throw new ServiceError('AuthFailed', this.id, `the API token lacks the ${scope} scope`, { remedy: SCOPES_REMEDY });
    }
}

/** Reclaimerr stores UTC but serialises some timestamps without an offset; say so, or they read as local time. */
function utc(v: string | null | undefined): string {
    if (typeof v !== 'string' || v === '') return '';
    return /(?:Z|[+-]\d{2}:?\d{2})$/.test(v) ? v : `${v}Z`;
}

function optionalNum<K extends string>(key: K, v: number | null | undefined): Partial<Record<K, number>> {
    return (typeof v === 'number' ? { [key]: v } : {}) as Partial<Record<K, number>>;
}

function soonestFirst(a: CleanupCandidate, b: CleanupCandidate): number {
    return STATE_ORDER[a.state] - STATE_ORDER[b.state] || (a.eligibleAt ?? '9999').localeCompare(b.eligibleAt ?? '9999') || a.title.localeCompare(b.title);
}
