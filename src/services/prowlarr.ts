import type { KeyedServiceConfig, ServiceId } from '../config/schema.ts';
import { apiKeyHeader } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { fenceText } from '../core/fence.ts';
import { ServiceHttp } from '../core/http.ts';
import type { components } from './generated/prowlarr.ts';
import {
    diagnoseConnection,
    type ConnectionDiagnosis,
    type HealthCheck,
    type HealthCheckCapable,
    type IndexerCapable,
    type IndexerRejection,
    type IndexerSummary,
    type SearchCapable,
    type SearchHit,
    type SearchSource,
    type ServiceAdapter
} from './types.ts';

type RawStatus = components['schemas']['SystemResource'];
type RawHealthCheck = components['schemas']['HealthResource'];
type RawIndexer = { id?: number; name?: string; enable?: boolean; protocol?: string; priority?: number };
type RawIndexerStatus = { indexerId?: number; disabledTill?: string; mostRecentFailure?: string };
type RawIndexerStats = {
    indexers?: {
        indexerId?: number;
        numberOfQueries?: number;
        numberOfGrabs?: number;
        numberOfRejectedQueries?: number;
        numberOfRejectedGrabs?: number;
    }[];
};
type RawHistoryRecord = {
    indexerId?: number;
    date?: string;
    successful?: boolean;
    eventType?: string;
    /**
     * Confirmed against a live Prowlarr 2.0.5: this carries `limit`, `offset`,
     * `elapsedTime`, `query`, `queryType`, `categories`, `source`, `host`,
     * `queryResults`, `url` and `cached` — and **no `reason` field**. The
     * adapter read `data.reason` first and would have reported every rejection
     * as "no reason given".
     */
    data?: { query?: string; reason?: string; source?: string; queryType?: string };
};
type RawRelease = {
    guid?: string;
    title?: string;
    indexer?: string;
    size?: number;
    seeders?: number;
    publishDate?: string;
};

/**
 * Prowlarr manages indexers, not files, and exposes no diskspace endpoint —
 * `/api/v1/diskspace` returns 404, confirmed against a live instance. It is
 * therefore deliberately not `DiskSpaceCapable`: a method with no fixture is
 * one stack_health would call and nothing would have tested.
 *
 * It is also API v1, not v3 — Prowlarr never had a v3 like its siblings.
 */
export class ProwlarrAdapter implements ServiceAdapter, HealthCheckCapable, IndexerCapable, SearchCapable {
    readonly type: ServiceId = 'prowlarr';
    readonly id: string = 'prowlarr';
    readonly #http: ServiceHttp;

    constructor(config: KeyedServiceConfig, fetchImpl: typeof fetch = fetch) {
        this.#http = new ServiceHttp('prowlarr', config, apiKeyHeader('X-Api-Key', config.api_key), fetchImpl);
    }

    async getVersion(): Promise<string> {
        const status = await this.#http.get<RawStatus>('/api/v1/system/status');
        if (!status.version) {
            throw new ServiceError('UpstreamError', this.id, 'system/status returned no version field');
        }
        return status.version;
    }

    async getFailedHealthChecks(): Promise<HealthCheck[]> {
        const all = await this.#http.get<RawHealthCheck[]>('/api/v1/health');
        return all
            .filter(c => c.type !== 'ok')
            .map(c => ({
                service: this.id,
                source: c.source ?? 'unknown',
                type: String(c.type ?? 'warning'),
                message: c.message ?? ''
            }));
    }

    /**
     * Three endpoints joined on indexerId. Statistics are optional: they are
     * the least important of the three and the most likely to be absent, so a
     * failure there degrades the row rather than the call.
     */
    async getIndexers(): Promise<IndexerSummary[]> {
        const [indexers, statuses] = await Promise.all([
            this.#http.get<RawIndexer[]>('/api/v1/indexer'),
            this.#http.get<RawIndexerStatus[]>('/api/v1/indexerstatus')
        ]);

        let stats: RawIndexerStats['indexers'] = [];
        try {
            stats = (await this.#http.get<RawIndexerStats>('/api/v1/indexerstats')).indexers ?? [];
        } catch {
            stats = [];
        }

        return indexers
            .filter((i): i is RawIndexer & { id: number } => typeof i.id === 'number')
            .map(i => {
                const status = statuses.find(s => s.indexerId === i.id);
                const stat = stats?.find(s => s.indexerId === i.id);
                return {
                    service: this.id,
                    id: i.id,
                    name: i.name ?? `indexer ${i.id}`,
                    enabled: i.enable ?? false,
                    protocol: i.protocol ?? 'unknown',
                    priority: i.priority ?? 0,
                    ...(status?.disabledTill === undefined ? {} : { disabledUntil: status.disabledTill }),
                    ...(status?.mostRecentFailure === undefined
                        ? {}
                        : {
                              lastFailure: fenceText(status.mostRecentFailure, {
                                  service: this.id,
                                  field: 'mostRecentFailure'
                              })
                          }),
                    ...(stat === undefined
                        ? {}
                        : {
                              queries: stat.numberOfQueries ?? 0,
                              grabs: stat.numberOfGrabs ?? 0,
                              rejectedQueries: stat.numberOfRejectedQueries ?? 0,
                              rejectedGrabs: stat.numberOfRejectedGrabs ?? 0
                          })
                };
            });
    }

    /**
     * The failed half of Prowlarr's history — the "recent rejections", which
     * is a different thing from the rejection *counts* above.
     *
     * **Prowlarr does not record why a query failed.** The history payload has
     * no reason field, so the best available answer is what kind of request it
     * was and which application asked. The *indexer's* own explanation lives on
     * `indexerstatus.mostRecentFailure`, which `getIndexers` already surfaces —
     * between the two, "which queries failed" and "what the indexer said" are
     * both answerable, just not from one endpoint.
     *
     * The query text is indexer-adjacent — it echoes back what reached the
     * indexer — so it is fenced along with the reason.
     */
    async getRecentRejections(limit: number): Promise<IndexerRejection[]> {
        // `successful=false` is pushed down to Prowlarr, which supports it.
        //
        // Without it `pageSize` bounded the *history* window and the failures
        // were picked out of it afterwards — so "the last 25 events" on a busy
        // indexer is mostly successes, and an indexer that failed forty queries
        // yesterday answered with an empty list today. "No recent rejections"
        // for a visibly failing indexer is the worst possible answer to the
        // question this method exists for.
        const [history, indexers] = await Promise.all([
            this.#http.get<{ records?: RawHistoryRecord[] }>(`/api/v1/history?pageSize=${limit}&successful=false`),
            this.#http.get<RawIndexer[]>('/api/v1/indexer')
        ]);

        // Resolved to a name here: a model handed `indexerId: 1` cannot say
        // which indexer is failing, which is the question this field answers.
        const nameOf = (id: number | undefined): string =>
            indexers.find(i => i.id === id)?.name ?? `indexer ${id ?? '?'}`;

        return (history.records ?? [])
            .filter(r => r.successful === false)
            .filter((r): r is RawHistoryRecord & { date: string } => typeof r.date === 'string')
            .map(r => {
                const described =
                    r.data?.reason ??
                    [r.eventType, r.data?.source === undefined ? undefined : `requested by ${r.data.source}`]
                        .filter(Boolean)
                        .join(', ');
                return {
                    indexer: nameOf(r.indexerId),
                    at: r.date,
                    reason: fenceText(described === '' ? 'failed, no reason recorded' : described, {
                        service: this.id,
                        field: 'reason'
                    }),
                    ...(r.data?.query
                        ? { query: fenceText(r.data.query, { service: this.id, field: 'query' }) }
                        : {})
                };
            });
    }

    async search(query: string, source: SearchSource): Promise<SearchHit[]> {
        if (source !== 'indexers') return [];

        const releases = await this.#http.get<RawRelease[]>(`/api/v1/search?query=${encodeURIComponent(query)}`);

        return releases.map((r, index) => ({
            service: this.id,
            source: 'indexers' as const,
            kind: 'release' as const,
            id: r.guid ?? String(index),
            // The single most important fenceText call in the codebase: this
            // string was chosen by whoever uploaded to a public indexer.
            title: fenceText(r.title ?? '', { service: this.id, field: 'title' }),
            ids: {},
            ...(r.indexer === undefined
                ? {}
                : { indexer: fenceText(r.indexer, { service: this.id, field: 'indexer' }) }),
            ...(r.size === undefined ? {} : { sizeBytes: r.size }),
            ...(r.seeders === undefined ? {} : { seeders: r.seeders }),
            ...(r.publishDate === undefined ? {} : { publishDate: r.publishDate })
        }));
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, this.type, () => this.getVersion());
    }
}
