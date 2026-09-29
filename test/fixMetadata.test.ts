import { instancesOf } from './helpers/instances.ts';
import { describe, expect, it, vi } from 'vitest';
import type * as z from 'zod/v4';
import type { AnyServiceConfig, MultiUserServiceConfig, PlexServiceConfig } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { IdentityResolver } from '../src/core/identity.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import type { MergedItem } from '../src/core/resolver.ts';
import { JellyfinAdapter } from '../src/services/jellyfin.ts';
import { PlexAdapter } from '../src/services/plex.ts';
import { registerFixMetadata } from '../src/tools/fixMetadata.ts';
import type { LibraryLoader } from '../src/tools/library.ts';
import type { WriteToolResult } from '../src/tools/write.ts';
import { jsonResponse } from './helpers/serve.ts';

const SERIES = 'cf939e2aa448fbe76b4f5eb80fa0d39f';
const TVDB = 88031;

const jellyfinConfig = (over: Partial<MultiUserServiceConfig> = {}): MultiUserServiceConfig =>
    ({
        url: 'http://192.0.2.10:8096',
        api_key: 'k',
        timeout_ms: 10_000,
        default_user: 'Sam',
        allow_other_users: false,
        permissions: { safe_write: true, destructive: true },
        ...over
    }) as MultiUserServiceConfig;

const episodeId = (n: number) => `${String(n).padStart(2, '0')}${'abcdef1234567890'.repeat(2)}`.slice(0, 32);

/** A correctly matched episode: the path agrees with the numbers and the title. */
const healthy = (n: number) => ({
    Id: episodeId(n),
    Name: `Real Episode Title ${n}`,
    IndexNumber: n,
    ParentIndexNumber: 1,
    Path: `/storage/tv/Some Show/Season 01/Some Show - S01E0${n} - Real Episode Title ${n} [Bluray-1080p].mkv`
});

/** The Dragon Ball Kai shape: a file in Specials shown as season 1. */
const broken = (n: number) => ({
    Id: episodeId(n + 50),
    Name: 'Prologue to Battle! The Return of Goku!',
    IndexNumber: 1,
    ParentIndexNumber: 1,
    Path: `/storage/tv/Dragon Ball Kai (2009)/Specials/Episode 10${n} Videl's Crisis Gohan's Urgent Call-out!.mkv`
});

const seriesItem = (over: Partial<MergedItem> = {}): MergedItem =>
    ({
        kind: 'series',
        title: 'Dragon Ball Kai',
        ids: { tvdb: TVDB },
        playback: { user: 'Sam', itemId: SERIES },
        presence: 'both',
        ...over
    }) as MergedItem;

type Call = (args: Record<string, unknown>) => Promise<{
    content: { type: 'text'; text: string }[];
    structuredContent: WriteToolResult;
}>;

function harness(
    opts: {
        config?: MultiUserServiceConfig;
        episodes?: Record<string, unknown>[];
        item?: MergedItem;
        films?: Record<string, unknown>[];
        /** No media-server adapter at all. */
        adapters?: 'none';
    } = {}
) {
    const config = opts.config ?? jellyfinConfig();
    const wrote: { method: string; path: string; query: string; body?: unknown }[] = [];

    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const method = init?.method ?? 'GET';

        if (url.pathname === '/Users') return jsonResponse([{ Id: 'user-sam', Name: 'Sam' }]);

        if (method === 'POST') {
            wrote.push({
                method,
                path: url.pathname,
                query: url.search,
                ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown })
            });
            // 204 rather than an empty JSON body: a Response cannot carry one
            // at that status, and this is what Jellyfin actually answers.
            return new Response(null, { status: 204 });
        }

        // Both film reads: the whole-library one and the by-id one fix_metadata
        // uses so a single repair does not pull the entire film library.
        if (url.pathname === '/Items') {
            const wanted = url.searchParams.get('ids');
            const films = opts.films ?? [];
            return jsonResponse({ Items: wanted === null ? films : films.filter(f => f.Id === wanted) });
        }

        if (url.pathname.startsWith('/Shows/')) {
            const rows = opts.episodes ?? [healthy(1), healthy(2), broken(1)];
            return jsonResponse({ Items: rows, TotalRecordCount: rows.length });
        }
        // A single item read, which the adapter uses when it needs one item
        // rather than a series' worth.
        if (url.pathname.startsWith('/Items/')) {
            const id = url.pathname.slice('/Items/'.length);
            const rows = opts.episodes ?? [healthy(1), healthy(2), broken(1)];
            const row = rows.find(r => r.Id === id);
            return row === undefined ? jsonResponse({ message: 'not found' }, 404) : jsonResponse(row);
        }
        return jsonResponse({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;

    const adapter = new JellyfinAdapter(config, impl);

    let call: Call = () => Promise.reject(new Error('not registered'));
    const server = {
        registerTool(_n: string, cfg: { inputSchema: z.ZodObject }, handler: Call) {
            call = args => handler(cfg.inputSchema.parse(args) as Record<string, unknown>);
        }
    };

    const loader = {
        load: async () => ({
            index: { search: () => [opts.item ?? seriesItem()] },
            degraded: []
        }),
        invalidate: vi.fn()
    } as unknown as LibraryLoader;

    registerFixMetadata(
        server as never,
        {
            permissions: permissionSourceFrom(instancesOf({ jellyfin: config as unknown as AnyServiceConfig })),
            confirm: new ConfirmTokens(),
            audit: WriteAudit.ephemeral(),
            library: loader
        },
        opts.adapters === 'none' ? [] : [adapter],
        loader,
        opts.adapters === 'none' ? undefined : new IdentityResolver(adapter, config)
    );

    return { call: (a: Record<string, unknown>) => call(a), wrote };
}

describe('fix_metadata', () => {
    it('shows the mismatching file itself, not just a count', async () => {
        // A count is not approvable for a destructive write: the person
        // confirming has to be able to see what the tool thinks is wrong.
        const h = harness();
        const { structuredContent } = await h.call({ query: 'Dragon Ball Kai' });

        expect(structuredContent.effects.join('\n')).toContain('Videl');
        expect(structuredContent.summary).toContain('1 of 3 episodes');
    });

    it('separates the confident finding from the advisory one', async () => {
        const h = harness();
        const text = (await h.call({ query: 'Dragon Ball Kai' })).structuredContent.effects.join('\n');

        expect(text).toContain("1 episode where the path's own season/episode number disagrees");
        expect(text).toContain('0 where only the title text disagrees');
    });

    it('previews without writing anything', async () => {
        const h = harness();
        const { structuredContent } = await h.call({ query: 'Dragon Ball Kai' });

        expect(structuredContent.applied).toBe(false);
        expect(structuredContent.confirm_token).toBeDefined();
        expect(h.wrote).toHaveLength(0);
    });

    it('is a no-op on a series whose files all agree with its metadata', async () => {
        const h = harness({ episodes: [healthy(1), healthy(2)] });
        const { structuredContent } = await h.call({ query: 'Dragon Ball Kai' });

        expect(structuredContent.noop).toBe(true);
        expect(structuredContent.confirm_token).toBeUndefined();
        expect(h.wrote).toHaveLength(0);
    });

    /**
     * "Nothing was compared" and "nothing is wrong" arrive at the same count.
     * Reporting the first as the second is the reassuring lie the whole
     * preview exists to prevent.
     */
    it('refuses rather than reporting a clean result when no paths came back', async () => {
        const h = harness({ episodes: [{ Id: episodeId(1), Name: 'No path here', IndexNumber: 1, ParentIndexNumber: 1 }] });
        await expect(h.call({ query: 'Dragon Ball Kai' })).rejects.toThrow(/no file paths/i);
    });

    describe('films', () => {
        const MOVIE = 'aa939e2aa448fbe76b4f5eb80fa0d39f';
        const asFilm = (over: Record<string, unknown> = {}) => ({
            Id: MOVIE,
            Name: 'The Thing',
            ProductionYear: 2011,
            Path: '/movies/The Thing (1982)/The Thing (1982) [Bluray-1080p].mkv',
            ...over
        });
        const filmItem = seriesItem({ kind: 'movie', title: 'The Thing', playback: { user: 'Sam', itemId: MOVIE } });

        /** The year is the film's confident signal, standing in for the
         *  numbering a film does not have. */
        it('flags a film whose file names a different year', async () => {
            const h = harness({ item: filmItem, films: [asFilm()] });
            const { structuredContent } = await h.call({ query: 'The Thing' });

            expect(structuredContent.noop).toBe(false);
            expect(structuredContent.effects.join('\n')).toContain('year');
            expect(structuredContent.summary).toContain('1 of 1 file');
        });

        it('is a no-op on a film whose file agrees with it', async () => {
            const h = harness({ item: filmItem, films: [asFilm({ ProductionYear: 1982 })] });
            expect((await h.call({ query: 'The Thing' })).structuredContent.noop).toBe(true);
        });

        it('prefers TMDB for a film, because Radarr is built on it', async () => {
            const h = harness({
                item: seriesItem({ kind: 'movie', title: 'The Thing', ids: { tmdb: 1234, tvdb: 9999 }, playback: { user: 'Sam', itemId: MOVIE } }),
                films: [asFilm()]
            });
            const preview = await h.call({ query: 'The Thing' });
            await h.call({ query: 'The Thing', confirm: preview.structuredContent.confirm_token });

            const apply = h.wrote.find(w => w.path.startsWith('/Items/RemoteSearch/Apply/'));
            expect(apply?.body).toEqual({ ProviderIds: { Tmdb: '1234' } });
        });
    });

    it('names both media servers when neither is configured', async () => {
        const h = harness({ adapters: 'none' });
        await expect(h.call({ query: 'Dragon Ball Kai' })).rejects.toThrow(/services\.jellyfin or services\.plex/);
    });

    it('says so when no TVDB id is known, because the refresh may re-match the same way', async () => {
        const h = harness({ item: seriesItem({ ids: {} }) });
        const { structuredContent } = await h.call({ query: 'Dragon Ball Kai' });

        expect(structuredContent.effects.join('\n')).toContain('identity is not pinned');
    });

    describe('applying', () => {
        const confirmed = async (h: ReturnType<typeof harness>) => {
            const preview = await h.call({ query: 'Dragon Ball Kai' });
            return h.call({ query: 'Dragon Ball Kai', confirm: preview.structuredContent.confirm_token });
        };

        /**
         * One call, not two. Checked against the server source:
         * ApplySearchCriteria sets the provider ids and then awaits a full
         * refresh itself before answering, so a second /Refresh is another full
         * provider fetch of the same item for nothing.
         */
        it('pins the id and stops, because the identify call refreshes on its own', async () => {
            const h = harness();
            const { structuredContent } = await confirmed(h);

            expect(structuredContent.applied).toBe(true);

            const apply = h.wrote.find(w => w.path.startsWith('/Items/RemoteSearch/Apply/'));
            expect(apply?.body).toEqual({ ProviderIds: { Tvdb: String(TVDB) } });
            expect(h.wrote.some(w => w.path.endsWith('/Refresh'))).toBe(false);
        });

        /**
         * Jellyfin ignores query parameters it does not recognise, so a wrong
         * spelling returns 204 and changes nothing — a silent no-op reported as
         * a completed repair. The casing comes from the vendored spec.
         */
        it('spells the refresh parameters the way the server actually reads them', async () => {
            // The plain refresh only runs when there is no id to pin.
            const h = harness({ item: seriesItem({ ids: {} }) });
            await confirmed(h);

            const refresh = h.wrote.find(w => w.path.endsWith('/Refresh'));
            const params = new URLSearchParams(refresh?.query ?? '');
            expect(params.get('metadataRefreshMode')).toBe('FullRefresh');
            expect(params.get('imageRefreshMode')).toBe('FullRefresh');
            expect(params.get('replaceAllMetadata')).toBe('true');
        });

        it('does not apply an empty match when no provider id is known', async () => {
            const h = harness({ item: seriesItem({ ids: {} }) });
            await confirmed(h);

            expect(h.wrote.some(w => w.path.startsWith('/Items/RemoteSearch/Apply/'))).toBe(false);
            expect(h.wrote.some(w => w.path.endsWith('/Refresh'))).toBe(true);
        });

        /** The queued path is the only one that cannot answer yet. */
        it('says the count may improve only when the refresh was queued', async () => {
            const queued = harness({ item: seriesItem({ ids: {} }) });
            const { structuredContent } = await confirmed(queued);
            expect(JSON.stringify(structuredContent.result)).toContain('queues');
        });

        /** The identify path finished the work before replying, so an unchanged
         *  count is a final answer and saying "may be too early" would be a
         *  hedge the server has already resolved. */
        it('gives a final answer when the server finished before replying', async () => {
            const h = harness();
            const { structuredContent } = await confirmed(h);
            const text = JSON.stringify(structuredContent.result);

            expect(text).toContain('final answer');
            expect(text).not.toContain('too early');
            expect(text).not.toContain('Matched to');
        });

        it('is refused outright when the destructive tier is off', async () => {
            const h = harness({
                config: jellyfinConfig({ permissions: { safe_write: true, destructive: false } } as Partial<MultiUserServiceConfig>)
            });
            await expect(confirmed(h)).rejects.toThrow();
            expect(h.wrote).toHaveLength(0);
        });
    });
});

/**
 * The failure this whole group exists for: the first live run of fix_metadata
 * returned `applied: true` having changed nothing, because every mismatching
 * episode was pinned to its own (wrong) provider id and a refresh re-fetches
 * each episode from the id stored on it.
 */
describe('episodes pinned to their own provider ids', () => {
    const pinned = (n: number) => ({ ...broken(n), ProviderIds: { AniDB: '97203', Tvdb: '507731' } });

    it('states the wider scope in the preview, before it is confirmed', async () => {
        const h = harness({ episodes: [pinned(1)] });
        const { structuredContent } = await h.call({ query: 'Dragon Ball Kai' });

        expect(structuredContent.summary).toContain('expected to change nothing');
        expect(structuredContent.effects.join('\n')).toContain('EXPECTED TO ACHIEVE NOTHING');
    });

    it('counts only the pinned mismatches, not every mismatch', async () => {
        const h = harness({ episodes: [pinned(1), broken(2), healthy(1)] });
        const text = (await h.call({ query: 'Dragon Ball Kai' })).structuredContent.effects.join('\n');

        expect(text).toContain('1 of the 2 mismatching episodes were matched to a specific provider episode');
        expect(text).not.toContain('EXPECTED TO ACHIEVE NOTHING');
    });

    it('says nothing about pinning when no episode carries an id', async () => {
        const h = harness();
        const text = (await h.call({ query: 'Dragon Ball Kai' })).structuredContent.effects.join('\n');

        expect(text).not.toContain('pinned');
    });

    /** A write the preview predicts will do nothing no longer issues a token:
     *  confirming a destructive no-op is how confirming becomes reflexive. */
    it('does not offer to confirm a repair it expects to achieve nothing', async () => {
        const h = harness({ episodes: [pinned(1)] });
        const { structuredContent } = await h.call({ query: 'Dragon Ball Kai' });

        expect(structuredContent.noop).toBe(true);
        expect(structuredContent.confirm_token).toBeUndefined();
        expect(h.wrote).toHaveLength(0);
    });

    it('reports the repair unverified when the mismatch count did not move', async () => {
        // Unpinned, so the repair is worth attempting and a token is issued.
        const h = harness({ episodes: [broken(1)] });
        const preview = await h.call({ query: 'Dragon Ball Kai' });
        const { structuredContent } = await h.call({
            query: 'Dragon Ball Kai',
            confirm: preview.structuredContent.confirm_token
        });

        // The write itself did happen — this is not a failed call.
        expect(structuredContent.applied).toBe(true);
        const result = structuredContent.result as { verified: boolean; note: string };
        expect(result.verified).toBe(false);
        expect(result.note).toContain('NOT FIXED');
    });
});

const PLEX_SERIES = '900100';

const plexConfig = (over: { allow?: boolean; destructive?: boolean } = {}): PlexServiceConfig => ({
    url: 'http://192.0.2.20:32400',
    api_key: 'tok',
    timeout_ms: 10_000,
    default_user: 'Sam',
    allow_other_users: false,
    allow_metadata_repair: over.allow ?? true,
    permissions: { safe_write: true, destructive: over.destructive ?? true }
});

/** Plex never matched these, so they carry no Guid and are not pinned. */
const plexEpisode = (n: number) => ({
    ratingKey: `90010${n}`,
    type: 'episode',
    title: 'Fixture show 2',
    parentIndex: 1,
    index: n,
    Media: [{ Part: [{ file: `/library/tv/Fixture show 2/Season 01/Fixture show 2 - S01E0${n} - Some other words.mkv` }] }]
});

const plexSeries = (over: Partial<MergedItem> = {}): MergedItem =>
    seriesItem({ title: 'Fixture show 2', ids: { tvdb: 900 }, playback: { user: 'Sam', itemId: PLEX_SERIES }, ...over });

function plexHarness(
    opts: { allow?: boolean; destructive?: boolean; item?: MergedItem; films?: Record<string, unknown>[];
        episodes?: Record<string, unknown>[];
        /** Served once a write has gone out. */
        repaired?: Record<string, unknown>[];
    } = {}
) {
    const config = plexConfig(opts);
    const sent: { method: string; path: string; params: Record<string, string> }[] = [];

    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const method = init?.method ?? 'GET';
        sent.push({ method, path: url.pathname, params: Object.fromEntries(url.searchParams) });

        if (method === 'PUT') return new Response(null);
        if (url.pathname === '/accounts') return jsonResponse({ MediaContainer: { Account: [{ id: 1, name: 'Sam' }] } });
        if (url.pathname === '/library/sections') {
            return jsonResponse({
                MediaContainer: {
                    Directory: [
                        { key: '1', type: 'movie', agent: 'tv.plex.agents.movie', language: 'en-US' },
                        { key: '2', type: 'show', agent: 'tv.plex.agents.series', language: 'en-US' }
                    ]
                }
            });
        }
        if (url.pathname === `/library/metadata/${PLEX_SERIES}/allLeaves`) {
            return jsonResponse({ MediaContainer: { Metadata: (sent.some(s => s.method === 'PUT') ? opts.repaired : undefined) ?? opts.episodes ?? [plexEpisode(1)] } });
        }
        if (url.pathname.endsWith('/matches')) {
            return jsonResponse({ MediaContainer: { SearchResult: [{ guid: 'plex://show/fixture2', name: 'Fixture show 2', year: 2001, score: 100 }] } });
        }
        const film = (opts.films ?? []).find(f => url.pathname === `/library/metadata/${String(f.ratingKey)}`);
        if (film !== undefined) return jsonResponse({ MediaContainer: { Metadata: [film] } });
        if (url.pathname === `/library/metadata/${PLEX_SERIES}`) {
            return jsonResponse({ MediaContainer: { Metadata: [{ ratingKey: PLEX_SERIES, type: 'show', librarySectionID: 2 }] } });
        }
        return jsonResponse({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;

    const adapter = new PlexAdapter(config, impl);
    const audit = WriteAudit.ephemeral();

    let call: Call = () => Promise.reject(new Error('not registered'));
    const server = {
        registerTool(_n: string, cfg: { inputSchema: z.ZodObject }, handler: Call) {
            call = args => handler(cfg.inputSchema.parse(args) as Record<string, unknown>);
        }
    };
    const loader = {
        load: async () => ({ index: { search: () => [opts.item ?? plexSeries()] }, degraded: [] }),
        invalidate: vi.fn()
    } as unknown as LibraryLoader;

    registerFixMetadata(
        server as never,
        {
            permissions: permissionSourceFrom(instancesOf({ plex: config as unknown as AnyServiceConfig })),
            confirm: new ConfirmTokens(),
            audit,
            library: loader
        },
        [adapter],
        loader,
        new IdentityResolver(adapter, config)
    );

    return {
        call: (a: Record<string, unknown>) => call(a),
        sent,
        audit,
        writes: () => sent.filter(s => s.method === 'PUT')
    };
}

const PLEX_OFF_REMEDY =
    'Set services.plex.allow_metadata_repair: true in config.yaml to allow it. It has not been verified against a live Plex server yet, see docs/tools.md.';

describe('fix_metadata on Plex', () => {
    const confirmed = async (h: ReturnType<typeof plexHarness>, query = 'Fixture show 2') => {
        const preview = await h.call({ query });
        return h.call({ query, confirm: preview.structuredContent.confirm_token });
    };

    it('previews against Plex and binds the token to the Plex item', async () => {
        const h = plexHarness();
        const { structuredContent } = await h.call({ query: 'Fixture show 2' });

        expect(structuredContent.service).toBe('plex');
        expect(structuredContent.target).toBe(`plex:${PLEX_SERIES}`);
        expect(structuredContent.confirm_token).toBeDefined();
        expect(h.writes()).toHaveLength(0);
    });

    it('matches by the TVDB id and refreshes on confirm', async () => {
        const h = plexHarness();
        const { structuredContent } = await confirmed(h);

        expect(structuredContent.applied).toBe(true);
        expect(h.writes().map(w => w.path)).toEqual([`/library/metadata/${PLEX_SERIES}/match`, `/library/metadata/${PLEX_SERIES}/refresh`]);
        expect(h.sent.find(s => s.path.endsWith('/matches'))?.params.title).toBe('tvdb-900');
    });

    it('does not claim the repair worked, because Plex refreshes in the background', async () => {
        const h = plexHarness();
        const result = (await confirmed(h)).structuredContent.result as { verified: boolean; note: string };

        expect(result.verified).toBe(false);
        expect(result.note).toContain('NOT VERIFIED');
        expect(result.note).toContain('get_metadata_issues again in a minute');
    });

    it('says what Plex matched the item to', async () => {
        const h = plexHarness();
        const { note } = (await confirmed(h)).structuredContent.result as { note: string };

        expect(note).toMatch(/Matched to <<untrusted:[^>]*>>Fixture show 2<<\/untrusted>> \(2001\)\./);
    });

    it('says what Plex matched to when the repair already shows', async () => {
        const fixed = { ...plexEpisode(1), title: 'Some other words' };
        const h = plexHarness({ repaired: [fixed] });
        const { note } = (await confirmed(h)).structuredContent.result as { note: string };

        expect(note).toContain('Repaired');
        expect(note).toMatch(/Matched to .*Fixture show 2.* \(2001\)\./);
    });

    it('names no match on a plain refresh', async () => {
        const h = plexHarness({ item: plexSeries({ ids: {} }) });
        const { note } = (await confirmed(h)).structuredContent.result as { note: string };
        expect(note).not.toContain('Matched to');
    });

    it('matches a film by its TMDB id', async () => {
        const film = {
            ratingKey: '900200',
            type: 'movie',
            title: 'Fixture film',
            year: 2011,
            librarySectionID: 1,
            Media: [{ Part: [{ file: '/library/movies/Fixture film (1982)/Fixture film (1982).mkv' }] }]
        };
        const h = plexHarness({
            item: plexSeries({ kind: 'movie', title: 'Fixture film', ids: { tmdb: 901, tvdb: 902 }, playback: { user: 'Sam', itemId: '900200' } }),
            films: [film]
        });
        await confirmed(h, 'Fixture film');

        expect(h.sent.find(s => s.path === '/library/metadata/900200/matches')?.params).toMatchObject({
            title: 'tmdb-901',
            agent: 'tv.plex.agents.movie'
        });
        expect(h.writes().map(w => w.path)).toEqual(['/library/metadata/900200/match', '/library/metadata/900200/refresh']);
    });

    it('only refreshes when no provider id is known', async () => {
        const h = plexHarness({ item: plexSeries({ ids: {} }) });
        await confirmed(h);

        expect(h.writes().map(w => w.path)).toEqual([`/library/metadata/${PLEX_SERIES}/refresh`]);
        expect(h.sent.some(s => s.path.endsWith('/matches'))).toBe(false);
    });

    it('previews the real mismatches with the setting off, refused and with no token', async () => {
        const h = plexHarness({ allow: false });
        const { structuredContent } = await h.call({ query: 'Fixture show 2', dry_run: true });

        expect(structuredContent.noop).toBe(false);
        expect(structuredContent.effects.join('\n')).toContain('Some other words');
        expect(structuredContent.permission).toEqual({ allowed: false, reason: 'Plex repair is off', remedy: PLEX_OFF_REMEDY });
        expect(structuredContent.confirm_token).toBeUndefined();
        expect(h.writes()).toHaveLength(0);
    });

    it('refuses the write with the setting off and audits it as denied', async () => {
        const h = plexHarness({ allow: false });
        await expect(h.call({ query: 'Fixture show 2' })).rejects.toThrow(/Plex repair is off/);

        expect(h.audit.recent()[0]).toMatchObject({
            tool: 'fix_metadata',
            service: 'plex',
            target: `plex:${PLEX_SERIES}`,
            outcome: 'denied',
            detail: 'Plex repair is off'
        });
        expect(h.writes()).toHaveLength(0);
    });

    it('names the setting ahead of the destructive tier when both are off', async () => {
        const h = plexHarness({ allow: false, destructive: false });
        await expect(h.call({ query: 'Fixture show 2' })).rejects.toThrow(/Plex repair is off/);
    });

    it('is refused when the destructive tier is off, even with the setting on', async () => {
        const h = plexHarness({ destructive: false });
        await expect(h.call({ query: 'Fixture show 2' })).rejects.toThrow(/destructive writes are disabled for plex/);
        expect(h.writes()).toHaveLength(0);
    });
});
