import type { ConfigByService, ServiceId } from '../config/schema.ts';
import { apiKeyHeader, noAuth } from '../core/auth.ts';
import { SHORT_READ_TTL_MS, cached } from '../core/cache.ts';
import { ServiceError } from '../core/errors.ts';
import { fencer } from '../core/fence.ts';
import { instantOf, isoInstant, newestFirst } from '../core/instant.ts';
import { logger } from '../core/logger.ts';
import { ServiceHttp } from '../core/http.ts';
import {
    diagnoseConnection,
    type CleanupCandidate,
    type CleanupCapable,
    type CleanupOverview,
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

type RawStatus = { status?: number; version?: string };
type RawHealth = { status?: string; database?: string };
export type RawCollection = {
    id?: number;
    title?: string;
    isActive?: boolean;
    arrAction?: number;
    deleteAfterDays?: number | null;
    /** movie, show, season or episode. */
    type?: string;
    totalSizeBytes?: number | null;
    handledMediaAmount?: number | null;
    handledMediaSizeBytes?: number | null;
};
/** A collection member. `tmdbId` is the show's on a show collection. */
export type RawMember = {
    id?: number;
    collectionId?: number;
    tmdbId?: number | null;
    addDate?: string;
    isManual?: boolean;
    ruleEvaluationFailed?: boolean;
};
type RawContent = { totalSize?: number; items?: (RawMember & { mediaData?: { title?: string; year?: number | null } })[] };
type RawLog = { id?: number; timestamp?: string; message?: string; type?: number; meta?: { type?: string } | null };
type RawLogPage = { totalSize?: number; items?: RawLog[] };
/**
 * What one collection's content read found: a title per member row id, and
 * whether it stopped at the page cap with members still unread. `capped` is
 * the difference between a member the media server does not hold and one this
 * read never asked about, which look identical in `byMember`.
 */
type Titles = { byMember: Map<number, { title: string; year?: number }>; capped: boolean };

/**
 * Maintainerr's ServarrAction, by ordinal: what a collection does to a member
 * once its days are up. Only the first three and DELETE_SHOW_IF_EMPTY delete files.
 */
const ACTIONS = [
    'delete',
    'unmonitor and delete all',
    'unmonitor and delete existing',
    'unmonitor',
    'do nothing',
    'delete show if empty',
    'unmonitor show if empty',
    'change quality profile'
];
const DELETES = new Set([0, 1, 2, 5]);
/** ECollectionLogType.MEDIA: the log rows about one member. */
const MEDIA_LOG = 1;
/** Soonest to go first; held-back ones last. */
const STATE_ORDER: Record<CleanupState, number> = { eligible: 0, scheduled: 1, postponed: 2, disabled: 3, canceled: 4 };
const EMITTED = new Set<HistoryEventType>(['deleted', 'scheduled', 'protected', 'unknown']);

const PAGE_SIZE = 100;
const MAX_PAGES = 10;
/** Long enough to share one read between the checks and the overview of a single get_stack_health. */
const READ_TTL_MS = 30_000;
const DAY_MS = 86_400_000;

const kindOf = (type: string | undefined): 'movie' | 'series' => (type === 'movie' ? 'movie' : 'series');
const scopeOf = (type: string | undefined): string => (type === 'movie' ? 'movie' : type === 'show' || type === undefined ? 'series' : type);
const deletes = (c: RawCollection): boolean => c.isActive === true && DELETES.has(c.arrAction ?? -1) && typeof c.deleteAfterDays === 'number';

/**
 * Maintainerr's own API, the one its web UI calls, checked live on 3.33.0. It
 * has no authentication, and its README says the collection routes are
 * internal to the app rather than a compatibility contract, so this reads as
 * little as it needs and never touches `/api/settings`, which answers with the
 * Plex token and every *arr key to anyone who asks. Read only.
 */
export class MaintainerrAdapter implements ServiceAdapter, HealthCheckCapable, HistoryCapable, CleanupCapable {
    readonly type: ServiceId = 'maintainerr';
    readonly id = 'maintainerr';
    readonly #http: ServiceHttp;
    readonly #status = cached(SHORT_READ_TTL_MS, () => this.#http.get<RawStatus>('/api/app/status'));
    readonly #collections = cached(READ_TTL_MS, () => this.#http.get<RawCollection[]>('/api/collections'));
    readonly #members = cached(READ_TTL_MS, () => this.#readMembers());

    constructor(config: ConfigByService['maintainerr'], fetchImpl: typeof fetch = fetch) {
        // Maintainerr ignores a key; one is sent only for a proxy in front of it that checks one.
        this.#http = new ServiceHttp(this.id, config, config.api_key === undefined ? noAuth : apiKeyHeader('X-Api-Key', config.api_key), fetchImpl);
    }

    async getVersion(): Promise<string> {
        const status = await this.#status();
        if (!status.version) throw new ServiceError('UpstreamError', this.id, 'app status returned no version field');
        return status.version;
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        this.#status.clear();
        return diagnoseConnection(this.id, this.type, () => this.getVersion());
    }

    async getFailedHealthChecks(): Promise<HealthCheck[]> {
        const check = (source: string, type: string, message: string): HealthCheck => ({ service: this.id, source, type, message });
        const fence = fencer(this.id);
        const [health, collections, members] = await Promise.all([this.#http.get<RawHealth>('/api/health'), this.#collections(), this.#members()]);
        const out: HealthCheck[] = [];
        if (health.status !== 'ok' || health.database !== 'ok') {
            out.push(check('health', 'error', `Maintainerr reports status ${health.status ?? 'unknown'}, database ${health.database ?? 'unknown'}`));
        }
        for (const c of collections) {
            // The collection handler skips these, so they stay in the collection and are never acted on.
            const failed = (members.get(c.id ?? -1) ?? []).filter(m => m.ruleEvaluationFailed === true && m.isManual !== true).length;
            if (failed > 0) {
                out.push(check('collection', 'warning', fence(`${failed} item(s) in ${c.title ?? `collection ${c.id}`} failed rule evaluation, so Maintainerr will not act on them`, 'message')));
            }
        }
        return out;
    }

    async readCleanupOverview(want: number): Promise<CleanupOverview> {
        const [collections, members, exclusions] = await Promise.all([this.#collections(), this.#members(), this.#http.get<unknown[]>('/api/rules/exclusion')]);
        const titles = await Promise.all(collections.map(c => this.#titles(c)));
        const candidates = collections.flatMap((c, i) => (members.get(c.id ?? -1) ?? []).map(m => this.#candidateOf(c, m, titles[i] ?? UNREAD_TITLES))).sort(soonestFirst);
        const going = candidates.filter(c => c.state === 'eligible' || c.state === 'scheduled');
        const firstAt = going.map(c => c.eligibleAt).filter((d): d is string => d !== undefined).sort()[0];
        const sum = (f: (c: RawCollection) => number | null | undefined) => collections.reduce((n, c) => n + (f(c) ?? 0), 0);
        return {
            service: this.id,
            // The collection handler runs on Maintainerr's own schedule; it deletes only for a collection set to.
            autoDelete: { enabled: collections.some(deletes) },
            totals: {
                candidates: candidates.length,
                reclaimableBytes: sum(c => (deletes(c) ? c.totalSizeBytes : 0)),
                reclaimedBytes: sum(c => c.handledMediaSizeBytes),
                reclaimedItems: sum(c => c.handledMediaAmount)
            },
            rules: collections.map(c => this.#ruleOf(c)),
            candidates: { items: candidates.slice(0, Math.max(0, want)), total: candidates.length },
            going: { count: going.length, ...(firstAt === undefined ? {} : { firstAt }) },
            protections: Array.isArray(exclusions) ? exclusions.length : 0,
            // Every member is listed, since the member list is not paged; what a
            // capped read costs is the titles of the ones past the cap.
            ...(titles.some(t => t.capped) ? { capped: true as const } : {})
        };
    }

    /**
     * Exclusions are keyed by media-server id and removal logs name a title
     * only in their message, so neither can be matched to a TMDB id: both
     * lists stay empty, and get_history has the removals.
     */
    async readCleanupStatus(kind: 'movie' | 'series', tmdbId: number): Promise<CleanupStatus> {
        const [collections, members] = await Promise.all([this.#collections(), this.#members()]);
        const hits = collections
            .filter(c => kindOf(c.type) === kind)
            .map(c => ({ c, matched: (members.get(c.id ?? -1) ?? []).filter(m => m.tmdbId === tmdbId) }))
            .filter(h => h.matched.length > 0);
        const candidates = await Promise.all(
            hits.map(async ({ c, matched }) => {
                const titles = await this.#titles(c);
                return matched.map(m => this.#candidateOf(c, m, titles));
            })
        );
        return { service: this.id, candidates: candidates.flat().sort(soonestFirst), protections: [], removals: [] };
    }

    async readHistory(opts: HistoryQuery): Promise<Window<HistoryEntry>> {
        if (opts.id !== undefined) {
            throw new ServiceError('NotFound', this.id, 'Maintainerr history is not scoped by a movie or series id', {
                remedy: 'Leave out `id`: Maintainerr answers for the whole library, and get_media_details shows one title’s cleanup state.'
            });
        }
        if (opts.eventType !== undefined && !EMITTED.has(opts.eventType)) return { items: [], total: 0 };
        const collections = await this.#collections();
        const since = opts.since === undefined ? undefined : instantOf(opts.since);
        const keep = (e: HistoryEntry) => (opts.eventType === undefined || e.event === opts.eventType) && (since === undefined || instantOf(e.at) >= since);
        const reads = await Promise.all(collections.map(c => this.#logs(c, keep, since, opts.want)));
        const items = reads.flat().sort(newestFirst);
        return { items, total: items.length };
    }

    /**
     * A log row's kind is only in its message: `Added "X"`, `Successfully
     * handled "X"`, `Removed "X"`, `Added a specific exclusion for "X"`. These
     * are fixed English strings in Maintainerr's server, not translated.
     */
    #entryOf(c: RawCollection, log: RawLog): HistoryEntry {
        const fence = fencer(this.id);
        const message = log.message ?? '';
        const open = message.indexOf('"');
        const close = message.lastIndexOf('"');
        const verb = (open === -1 ? message : message.slice(0, open)).trim();
        const title = open !== -1 && close > open ? message.slice(open + 1, close) : '';
        const event: HistoryEventType =
            verb === 'Successfully handled' && deletes(c)
                ? 'deleted'
                : verb === 'Added' && deletes(c)
                  ? 'scheduled'
                  : verb === 'Added a specific exclusion for'
                    ? 'protected'
                    : 'unknown';
        return {
            service: this.id,
            id: `${c.id ?? ''}:${log.id ?? ''}`,
            at: isoInstant(log.timestamp) ?? '',
            event,
            rawEvent: open === -1 ? 'media' : verb,
            title: fence(title, 'title'),
            reason: fence(`rule ${c.title ?? `collection ${c.id}`}`, 'reason')
        };
    }

    #candidateOf(c: RawCollection, m: RawMember, titles: Titles): CleanupCandidate {
        const fence = fencer(this.id);
        const added = isoInstant(m.addDate);
        const eligibleAt = added === undefined || typeof c.deleteAfterDays !== 'number' ? undefined : new Date(Date.parse(added) + c.deleteAfterDays * DAY_MS).toISOString();
        const failed = m.ruleEvaluationFailed === true && m.isManual !== true;
        const known = titles.byMember.get(m.id ?? -1);
        const state: CleanupState = !deletes(c) || failed || eligibleAt === undefined ? 'disabled' : Date.parse(eligibleAt) <= Date.now() ? 'eligible' : 'scheduled';
        const blockers = [
            ...(c.isActive === true ? [] : ['the collection is inactive']),
            ...(DELETES.has(c.arrAction ?? -1) ? [] : [`the collection's action is ${ACTIONS[c.arrAction ?? -1] ?? 'unknown'}`]),
            ...(typeof c.deleteAfterDays === 'number' ? [] : ['the collection has no days set before it acts']),
            ...(failed ? ['rule evaluation failed'] : []),
            // Only where the read reached the whole collection: past the cap a
            // member has no title because nothing looked it up, not because
            // Maintainerr could not find it.
            ...(known === undefined && !titles.capped ? ['not found on the media server'] : [])
        ];
        return {
            id: `${c.id ?? ''}:${m.id ?? ''}`,
            kind: kindOf(c.type),
            scope: scopeOf(c.type),
            title: fence(known?.title ?? (typeof m.tmdbId === 'number' ? `TMDB ${m.tmdbId}` : ''), 'title'),
            ...(known?.year === undefined ? {} : { year: known.year }),
            ...(typeof m.tmdbId === 'number' ? { tmdbId: m.tmdbId } : {}),
            rules: [fence(c.title ?? '', 'rule')],
            operation: 'delete',
            state,
            ...(eligibleAt === undefined || !deletes(c) ? {} : { eligibleAt }),
            ...(blockers.length === 0 ? {} : { blockers: blockers.map(b => fence(b, 'blocker')) })
        };
    }

    #ruleOf(c: RawCollection): CleanupRule {
        return {
            id: String(c.id ?? ''),
            name: fencer(this.id)(c.title ?? '', 'rule'),
            kind: c.type ?? '',
            outcome: ACTIONS[c.arrAction ?? -1] ?? '',
            enabled: c.isActive === true
        };
    }

    /** Every member of every collection, by collection id: the light list, with no media-server lookup. */
    async #readMembers(): Promise<Map<number, RawMember[]>> {
        const collections = await this.#collections();
        const lists = await Promise.all(
            collections.map(async c => [c.id ?? -1, await this.#http.get<RawMember[]>(`/api/collections/media?collectionId=${c.id ?? -1}`)] as const)
        );
        return new Map(lists.map(([id, list]) => [id, Array.isArray(list) ? list : []]));
    }

    /**
     * Titles by member row id. The content route looks each member up on the
     * media server and silently drops one it cannot find, while `totalSize`
     * still counts it, so it can hold fewer rows than the collection has. A
     * collection longer than `MAX_PAGES` pages reports `capped`, because the
     * rows it never read are not absent from the media server.
     */
    async #titles(c: RawCollection): Promise<Titles> {
        const byMember = new Map<number, { title: string; year?: number }>();
        for (let page = 1; page <= MAX_PAGES; page += 1) {
            const body = await this.#http.get<RawContent>(`/api/collections/media/${c.id ?? -1}/content/${page}?size=${PAGE_SIZE}&sort=deleteSoonest&sortOrder=asc`);
            for (const item of body.items ?? []) {
                const title = item.mediaData?.title;
                if (typeof item.id === 'number' && typeof title === 'string') {
                    byMember.set(item.id, { title, ...(typeof item.mediaData?.year === 'number' ? { year: item.mediaData.year } : {}) });
                }
            }
            if (page * PAGE_SIZE >= (body.totalSize ?? 0)) return { byMember, capped: false };
        }
        logger.warn({ service: this.id, collection: c.id }, 'collection over the page cap; later titles are not read');
        return { byMember, capped: true };
    }

    /** Newest first, as Maintainerr serves them, until `since` or `want` is reached. */
    async #logs(c: RawCollection, keep: (e: HistoryEntry) => boolean, since: number | undefined, want: number | undefined): Promise<HistoryEntry[]> {
        const out: HistoryEntry[] = [];
        for (let page = 1; page <= MAX_PAGES; page += 1) {
            const body = await this.#http.get<RawLogPage>(`/api/collections/logs/${c.id ?? -1}/content/${page}?size=${PAGE_SIZE}&filter=${MEDIA_LOG}`);
            const rows = body.items ?? [];
            out.push(...rows.filter(l => l.type === MEDIA_LOG).map(l => this.#entryOf(c, l)).filter(keep));
            const oldest = rows.at(-1)?.timestamp;
            const done =
                rows.length === 0 ||
                page * PAGE_SIZE >= (body.totalSize ?? 0) ||
                (since !== undefined && oldest !== undefined && instantOf(oldest) < since) ||
                (since === undefined && want !== undefined && out.length >= want);
            if (done) return out;
        }
        return out;
    }
}

/** No read at all, so no member of it can be called missing from the media server. */
const UNREAD_TITLES: Titles = { byMember: new Map(), capped: true };

function soonestFirst(a: CleanupCandidate, b: CleanupCandidate): number {
    return STATE_ORDER[a.state] - STATE_ORDER[b.state] || (a.eligibleAt ?? '9999').localeCompare(b.eligibleAt ?? '9999') || a.title.localeCompare(b.title);
}
