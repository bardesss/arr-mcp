import { instancesOf } from './helpers/instances.ts';
import { describe, expect, it, vi } from 'vitest';
import type * as z from 'zod/v4';
import type { AnyServiceConfig, MultiUserServiceConfig } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { IdentityResolver } from '../src/core/identity.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import type { MergedItem } from '../src/core/resolver.ts';
import { JellyfinAdapter } from '../src/services/jellyfin.ts';
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
        /** Stand in a Plex adapter beside (or instead of) Jellyfin. */
        adapters?: 'plex-only';
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
    const plexish = { id: 'plex', type: 'plex' } as never;

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
        opts.adapters === 'plex-only' ? [plexish] : [adapter],
        loader,
        opts.adapters === 'plex-only' ? undefined : new IdentityResolver(adapter, config)
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

    it('refuses a film, which has no episode numbering to show as evidence', async () => {
        const h = harness({ item: seriesItem({ kind: 'movie', title: 'Alien' }) });
        await expect(h.call({ query: 'Alien' })).rejects.toThrow(/only repairs series/);
    });

    it('tells a Plex user this is a Jellyfin repair, not that they have no media server', async () => {
        const h = harness({ adapters: 'plex-only' });
        await expect(h.call({ query: 'Dragon Ball Kai' })).rejects.toThrow(/read-only/);
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

        it('pins the TVDB id before refreshing, so the agent cannot re-match the same way', async () => {
            const h = harness();
            const { structuredContent } = await confirmed(h);

            expect(structuredContent.applied).toBe(true);

            const apply = h.wrote.find(w => w.path.startsWith('/Items/RemoteSearch/Apply/'));
            expect(apply?.body).toEqual({ ProviderIds: { Tvdb: String(TVDB) } });

            const refresh = h.wrote.find(w => w.path.endsWith('/Refresh'));
            expect(refresh).toBeDefined();
            expect(h.wrote.indexOf(apply!)).toBeLessThan(h.wrote.indexOf(refresh!));
        });

        /**
         * Jellyfin ignores query parameters it does not recognise, so a wrong
         * spelling returns 204 and changes nothing — a silent no-op reported as
         * a completed repair. The casing comes from the vendored spec.
         */
        it('spells the refresh parameters the way the server actually reads them', async () => {
            const h = harness();
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

        it('does not claim the refresh finished, because Jellyfin runs it in the background', async () => {
            const h = harness();
            const { structuredContent } = await confirmed(h);

            expect(JSON.stringify(structuredContent.result)).toContain('background');
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

    it('reports the repair unverified when the mismatch count did not move', async () => {
        const h = harness({ episodes: [pinned(1)] });
        const preview = await h.call({ query: 'Dragon Ball Kai' });
        const { structuredContent } = await h.call({
            query: 'Dragon Ball Kai',
            confirm: preview.structuredContent.confirm_token
        });

        // The write itself did happen — this is not a failed call.
        expect(structuredContent.applied).toBe(true);
        const result = structuredContent.result as { verified: boolean; note: string };
        expect(result.verified).toBe(false);
        expect(result.note).toContain('NOT VERIFIED');
    });
});
