import { instanceId } from '../config/instances.ts';
import type { ConfigByService, ServiceId } from '../config/schema.ts';
import { apiKeyHeader } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { fenceText } from '../core/fence.ts';
import { ServiceHttp } from '../core/http.ts';
import { readSeedCriteria } from './arrSeedCriteria.ts';
import type { components } from './generated/prowlarr.ts';
import {
    diagnoseConnection,
    type CommandHandle,
    type ConnectionDiagnosis,
    type HealthCheck,
    type HealthCheckCapable,
    type IndexerCapable,
    type IndexerDefinition,
    type IndexerLookups,
    type IndexerRejection,
    type IndexerSeeding,
    type IndexerSettings,
    type IndexerSyncApp,
    type IndexerSeedCriteria,
    type IndexerSummary,
    type IndexerSyncLevel,
    type IndexerSyncView,
    type IndexerWriteCapable,
    type LibraryScanCapable,
    type SearchCapable,
    type SearchHit,
    type SearchSource,
    type SeedCriteriaCapable,
    type ServiceAdapter
} from './types.ts';

type RawStatus = components['schemas']['SystemResource'];
type RawHealthCheck = components['schemas']['HealthResource'];
type RawField = { name?: string; value?: unknown; type?: string; privacy?: string };
type RawIndexer = {
    id?: number;
    name?: string;
    definitionName?: string;
    enable?: boolean;
    protocol?: string;
    privacy?: string;
    priority?: number;
    appProfileId?: number;
    tags?: number[];
    fields?: RawField[];
    capabilities?: { categories?: { id?: number; subCategories?: { id?: number }[] }[] };
};
type RawApplication = { name?: string; implementation?: string; syncLevel?: string; tags?: number[]; fields?: RawField[] };
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
export class ProwlarrAdapter
    implements
        ServiceAdapter,
        HealthCheckCapable,
        IndexerCapable,
        IndexerWriteCapable,
        SearchCapable,
        LibraryScanCapable,
        SeedCriteriaCapable
{
    readonly type: ServiceId = 'prowlarr';
    readonly instance: string | undefined;
    readonly id: string;
    readonly #http: ServiceHttp;

    constructor(config: ConfigByService['prowlarr'], fetchImpl: typeof fetch = fetch) {
        this.instance = config.name;
        this.id = instanceId('prowlarr', config.name);
        this.#http = new ServiceHttp(this.id, config, apiKeyHeader('X-Api-Key', config.api_key), fetchImpl);
    }

    async getVersion(): Promise<string> {
        const status = await this.#http.get<RawStatus>('/api/v1/system/status');
        if (!status.version) {
            throw new ServiceError('UpstreamError', this.id, 'system/status returned no version field');
        }
        return status.version;
    }

    /**
     * Prowlarr's answer to "reconcile yourself with the world": it pushes the
     * indexer list to every application it manages. Not a library scan — it
     * has no library — but the same shape of action, which is why
     * `trigger_scan` owns it rather than a tool of its own.
     *
     * v1, like everything else here.
     */
    async startLibraryScan(): Promise<CommandHandle> {
        const queued = await this.#http.post<{ id?: number; name?: string; status?: string }>('/api/v1/command', {
            name: 'ApplicationIndexerSync'
        });
        return {
            service: this.id,
            commandId: queued.id ?? 0,
            name: queued.name ?? 'ApplicationIndexerSync',
            ...(typeof queued.status === 'string' ? { status: queued.status } : {})
        };
    }

    async syncIndexers(): Promise<CommandHandle> {
        return this.startLibraryScan();
    }

    /**
     * The indexer plus every app Prowlarr syncs to, with what `reachOf`
     * needs to say whether the indexer reaches each one.
     */
    async readIndexerSync(id: number): Promise<IndexerSyncView | undefined> {
        const [indexers, apps, version] = await Promise.all([
            this.#http.get<RawIndexer[]>('/api/v1/indexer'),
            this.#http.get<RawApplication[]>('/api/v1/applications'),
            this.getVersion()
        ]);
        const indexer = indexers.find(i => i.id === id);
        if (indexer === undefined) return undefined;
        const tags = indexer.tags ?? [];

        return {
            indexer: {
                id,
                name: indexer.name ?? `indexer ${id}`,
                enabled: indexer.enable ?? false,
                protocol: indexer.protocol ?? 'unknown',
                priority: indexer.priority ?? 25,
                appProfileId: indexer.appProfileId ?? 0,
                tags,
                seeding: seedingOf(indexer.fields ?? []),
                ...categoriesOf(indexer)
            },
            apps: appsFor(apps),
            bulkEdit: atLeast(version, 1, 8)
        };
    }

    async readIndexerApps(): Promise<IndexerSyncApp[]> {
        return appsFor(await this.#http.get<RawApplication[]>('/api/v1/applications'));
    }

    async readIndexerLookups(): Promise<IndexerLookups> {
        const [profiles, tags] = await Promise.all([
            this.#http.get<{ id?: number; name?: string }[]>('/api/v1/appprofile'),
            this.#http.get<{ id?: number; label?: string }[]>('/api/v1/tag')
        ]);
        return {
            appProfiles: profiles.flatMap(p =>
                typeof p.id === 'number' ? [{ id: p.id, name: p.name ?? `profile ${p.id}` }] : []
            ),
            tags: tags.flatMap(t =>
                typeof t.id === 'number' && t.label !== undefined ? [{ id: t.id, label: t.label }] : []
            )
        };
    }

    async readIndexerDefinitions(): Promise<{
        definitions: IndexerDefinition[];
        configured: { id: number; definitionName: string }[];
    }> {
        const [schema, indexers] = await Promise.all([
            this.#http.get<RawIndexer[]>('/api/v1/indexer/schema'),
            this.#http.get<RawIndexer[]>('/api/v1/indexer')
        ]);
        return {
            definitions: schema
                .filter((d): d is RawIndexer & { definitionName: string } => typeof d.definitionName === 'string')
                .map(d => ({
                    definitionName: d.definitionName,
                    name: d.name ?? d.definitionName,
                    privacy: d.privacy ?? 'unknown',
                    protocol: d.protocol ?? 'unknown',
                    credentialFree: isCredentialFree(d),
                    ...categoriesOf(d)
                })),
            configured: indexers.flatMap(i =>
                typeof i.id === 'number' && typeof i.definitionName === 'string'
                    ? [{ id: i.id, definitionName: i.definitionName }]
                    : []
            )
        };
    }

    /**
     * Only ever a credential-free definition, checked again here rather than
     * trusted from the plan: the body is Prowlarr's own template with nothing
     * but the settings below changed, so no secret is ever written.
     *
     * Prowlarr tests the indexer before saving, which is a request to the
     * site itself. A site it cannot reach answers 400 and nothing is saved.
     */
    async addIndexer(definitionName: string, settings: IndexerSettings): Promise<number> {
        const schema = await this.#http.get<RawIndexer[]>('/api/v1/indexer/schema');
        const template = schema.find(d => d.definitionName === definitionName);
        if (template === undefined || !isCredentialFree(template)) {
            throw new ServiceError('NotFound', this.id, `no credential-free definition named "${definitionName}"`);
        }

        const seeding = SEED_FIELDS.filter(([key]) => settings[key] !== undefined);
        const body = {
            ...template,
            enable: true,
            ...(settings.priority === undefined ? {} : { priority: settings.priority }),
            ...(settings.appProfileId === undefined ? {} : { appProfileId: settings.appProfileId }),
            tags: settings.tags ?? [],
            fields: (template.fields ?? []).map(f => {
                const seed = seeding.find(([, field]) => field === f.name);
                return seed === undefined ? f : { ...f, value: settings[seed[0]] };
            })
        };

        try {
            const created = await this.#http.post<{ id?: number }>('/api/v1/indexer', body);
            return created.id ?? 0;
        } catch (err) {
            if (err instanceof ServiceError && err.detail.startsWith('HTTP 400')) {
                throw new ServiceError('UpstreamError', this.id, `Prowlarr refused to add ${definitionName}`, {
                    remedy: "Prowlarr tests an indexer before saving it, and the test failed: the site is usually down, blocked, or behind a captcha from here. Prowlarr's logs have its reason. Nothing was added.",
                    cause: err
                });
            }
            throw err;
        }
    }

    /** The bulk endpoint again, for the same reason: no credential round-trips. */
    async editIndexer(id: number, settings: IndexerSettings): Promise<void> {
        await this.#http.put(
            '/api/v1/indexer/bulk',
            {
                ids: [id],
                ...(settings.priority === undefined ? {} : { priority: settings.priority }),
                ...(settings.appProfileId === undefined ? {} : { appProfileId: settings.appProfileId }),
                ...(settings.tags === undefined ? {} : { tags: settings.tags, applyTags: 'replace' }),
                ...(settings.minimumSeeders === undefined ? {} : { minimumSeeders: settings.minimumSeeders }),
                ...(settings.seedRatio === undefined ? {} : { seedRatio: settings.seedRatio }),
                ...(settings.seedTime === undefined ? {} : { seedTime: settings.seedTime }),
                ...(settings.packSeedTime === undefined ? {} : { packSeedTime: settings.packSeedTime })
            },
            true
        );
    }

    /**
     * The bulk endpoint rather than `PUT /indexer/{id}`: it takes just the
     * flag, so the indexer's credentials never round-trip through here, and
     * it skips the connection test a single PUT runs. It arrived in 1.8.
     */
    async setIndexerEnabled(id: number, enabled: boolean): Promise<void> {
        await this.#http.put('/api/v1/indexer/bulk', { ids: [id], enable: enabled }, true);
    }

    async deleteIndexer(id: number): Promise<void> {
        await this.#http.delete(`/api/v1/indexer/${id}`);
    }

    async getFailedHealthChecks(): Promise<HealthCheck[]> {
        const all = await this.#http.get<RawHealthCheck[]>('/api/v1/health');
        return all
            .filter(c => c.type !== 'ok')
            .map(c => ({
                service: this.id,
                source: c.source ?? 'unknown',
                type: String(c.type ?? 'warning'),
                message: fenceText(c.message ?? '', { service: this.id, field: 'message' })
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

    async getSeedCriteria(): Promise<IndexerSeedCriteria[]> {
        return readSeedCriteria(this.#http, this.id, 'prowlarr');
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
                    service: this.id,
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

const SEED_FIELDS: [keyof IndexerSeeding, string][] = [
    ['minimumSeeders', 'torrentBaseSettings.appMinimumSeeders'],
    ['seedRatio', 'torrentBaseSettings.seedRatio'],
    ['seedTime', 'torrentBaseSettings.seedTime'],
    ['packSeedTime', 'torrentBaseSettings.packSeedTime']
];

const seedingOf = (fields: RawField[]): IndexerSeeding => {
    const out: IndexerSeeding = {};
    for (const [key, name] of SEED_FIELDS) {
        const value = fields.find(f => f.name === name)?.value;
        if (typeof value === 'number') out[key] = value;
    }
    return out;
};

/**
 * Prowlarr's own `privacy` flag on a field misses cookies and most Cardigann
 * passwords, so the field type is checked too. A public definition with no
 * password or captcha field is the only kind added without a person.
 */
const isCredentialFree = (d: RawIndexer): boolean =>
    d.privacy === 'public' &&
    (d.fields ?? []).every(
        f => f.type !== 'password' && f.type !== 'cardigannCaptcha' && (f.privacy ?? 'normal') === 'normal'
    );

/** Top-level categories and their subcategories, the set Prowlarr matches on. */
const categoriesOf = (d: RawIndexer): { categories?: number[] } => {
    const tree = d.capabilities?.categories;
    if (tree === undefined) return {};
    const ids = tree.flatMap(c => [c.id, ...(c.subCategories ?? []).map(s => s.id)]);
    return { categories: ids.filter((id): id is number => typeof id === 'number') };
};

/** Sonarr syncs `animeSyncCategories` as well as `syncCategories`; both count. */
const appsFor = (apps: RawApplication[]): IndexerSyncApp[] =>
    apps.map(a => {
        const synced = (a.fields ?? []).filter(f => /syncCategories$/i.test(f.name ?? ''));
        const categories = synced.flatMap(f =>
            Array.isArray(f.value) ? f.value.filter((v): v is number => typeof v === 'number') : []
        );
        return {
            name: a.name ?? a.implementation ?? 'unnamed app',
            implementation: a.implementation ?? 'unknown',
            syncLevel: syncLevelOf(a.syncLevel),
            tags: a.tags ?? [],
            ...(synced.length === 0 ? {} : { categories })
        };
    });

const atLeast = (version: string, major: number, minor: number): boolean => {
    const [a = 0, b = 0] = version.split('.').map(Number);
    return a > major || (a === major && b >= minor);
};

const syncLevelOf = (raw: string | undefined): IndexerSyncLevel =>
    raw === 'addOnly' || raw === 'fullSync' ? raw : 'disabled';
