import { instancesOf } from './helpers/instances.ts';
import { describe, expect, it, vi } from 'vitest';
import type * as z from 'zod/v4';
import type { AnyServiceConfig, MultiUserServiceConfig } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { IdentityResolver } from '../src/core/identity.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import { JellyfinAdapter } from '../src/services/jellyfin.ts';
import type { LibraryLoader } from '../src/tools/library.ts';
import { registerSetWatched } from '../src/tools/setWatched.ts';
import type { WriteToolResult } from '../src/tools/write.ts';
import { jsonResponse } from './helpers/serve.ts';

/**
 * Jellyfin item ids deliberately never enter the library index, so the ids
 * this tool takes can only have come from `get_playback` or a Jellyfin search
 * hit. A Radarr id passed here has to be refused legibly rather than turning
 * into a 404 from somewhere deep in the adapter.
 */

const SERIES = 'cf939e2aa448fbe76b4f5eb80fa0d39f';
const MOVIE = '65cbd491b1ecb02fdb3d7cbaefab5353';

const jellyfinConfig = (over: Partial<MultiUserServiceConfig> = {}): MultiUserServiceConfig =>
    ({
        url: 'http://192.0.2.10:8096',
        api_key: 'k',
        timeout_ms: 10_000,
        default_user: 'Sam',
        allow_other_users: false,
        permissions: { safe_write: true, destructive: false },
        ...over
    }) as MultiUserServiceConfig;

const USERS = [
    { Id: 'user-sam', Name: 'Sam' },
    { Id: 'user-alex', Name: 'Alex' }
];

/** Real-shaped ids: 32 hex characters. The adapter refuses anything else
 *  before it reaches the network, which is the point of the guard. */
const episodeId = (n: number) => `${String(n).padStart(2, '0')}${'abcdef1234567890'.repeat(2)}`.slice(0, 32);

const episode = (n: number, played: boolean) => ({
    Id: episodeId(n),
    Name: `Episode ${n}`,
    Type: 'Episode',
    IndexNumber: n,
    ParentIndexNumber: 2,
    UserData: { Played: played }
});

type Call = (args: Record<string, unknown>) => Promise<{
    content: { type: 'text'; text: string }[];
    structuredContent: WriteToolResult;
}>;

function harness(
    opts: {
        config?: MultiUserServiceConfig;
        item?: Record<string, unknown>;
        episodes?: Record<string, unknown>[];
    } = {}
) {
    const config = opts.config ?? jellyfinConfig();
    const marked: { method: string; path: string }[] = [];

    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const method = init?.method ?? 'GET';

        if (url.pathname.startsWith('/UserPlayedItems/')) {
            marked.push({ method, path: url.pathname });
            return jsonResponse({ Played: method === 'POST' });
        }
        if (url.pathname === '/Users') return jsonResponse(USERS);
        if (url.pathname.startsWith('/Shows/')) {
            const season = url.searchParams.get('season');
            const all = opts.episodes ?? [episode(1, false), episode(2, false)];
            const rows = season === null ? all : all.filter(e => String(e.ParentIndexNumber) === season);
            return jsonResponse({ Items: rows, TotalRecordCount: rows.length });
        }
        if (url.pathname === `/Items/${SERIES}`) {
            return jsonResponse(
                opts.item ?? { Id: SERIES, Name: 'Alien: Earth', Type: 'Series', UserData: { Played: false } }
            );
        }
        if (url.pathname === `/Items/${MOVIE}`) {
            return jsonResponse(opts.item ?? { Id: MOVIE, Name: 'Alien', Type: 'Movie', UserData: { Played: false } });
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

    const audit = WriteAudit.ephemeral();
    registerSetWatched(
        server as never,
        {
            permissions: permissionSourceFrom(instancesOf({ jellyfin: config as unknown as AnyServiceConfig })),
            confirm: new ConfirmTokens(),
            audit,
            library: { invalidate: vi.fn() } as unknown as LibraryLoader
        },
        [adapter],
        new IdentityResolver(adapter, config)
    );

    return { call: (a: Record<string, unknown>) => call(a), marked, audit };
}

describe('set_watched', () => {
    it('lists the episode count in the effects, not just the season', async () => {
        // "Marks season 2 watched" is not approvable — the caller cannot see
        // how much that is.
        const h = harness({ episodes: Array.from({ length: 10 }, (_, i) => episode(i + 1, false)) });
        const { structuredContent } = await h.call({ item_id: SERIES, season: 2, watched: true });

        expect(structuredContent.effects.join(' ')).toContain('10 episodes');
    });

    it('counts only the episodes that are not already in that state', async () => {
        const h = harness({ episodes: [episode(1, true), episode(2, false), episode(3, false)] });
        const { structuredContent } = await h.call({ item_id: SERIES, season: 2, watched: true });

        expect(structuredContent.effects.join(' ')).toContain('2 episodes');
    });

    it('refuses to mark someone else watched without allow_other_users', async () => {
        const h = harness();
        await expect(h.call({ item_id: MOVIE, watched: true, user: 'Alex' })).rejects.toThrow(/allow_other_users/);
        expect(h.marked).toHaveLength(0);
    });

    it('previews without changing watch state', async () => {
        const h = harness();
        const { structuredContent } = await h.call({ item_id: MOVIE, watched: true });

        expect(structuredContent.applied).toBe(false);
        expect(structuredContent.confirm_token).toBeDefined();
        expect(h.marked).toHaveLength(0);
    });

    it('marks it once the token comes back', async () => {
        const h = harness();
        const preview = await h.call({ item_id: MOVIE, watched: true });
        const applied = await h.call({
            item_id: MOVIE,
            watched: true,
            confirm: preview.structuredContent.confirm_token
        });

        expect(applied.structuredContent.applied).toBe(true);
        expect(h.marked).toEqual([{ method: 'POST', path: `/UserPlayedItems/${MOVIE}` }]);
    });

    it('deletes rather than posts when unmarking', async () => {
        const h = harness({ item: { Id: MOVIE, Name: 'Alien', Type: 'Movie', UserData: { Played: true } } });
        const preview = await h.call({ item_id: MOVIE, watched: false });
        await h.call({ item_id: MOVIE, watched: false, confirm: preview.structuredContent.confirm_token });

        expect(h.marked).toEqual([{ method: 'DELETE', path: `/UserPlayedItems/${MOVIE}` }]);
    });

    it('applies per episode for a season', async () => {
        const h = harness({ episodes: [episode(1, true), episode(2, false), episode(3, false)] });
        const preview = await h.call({ item_id: SERIES, season: 2, watched: true });
        await h.call({
            item_id: SERIES,
            season: 2,
            watched: true,
            confirm: preview.structuredContent.confirm_token
        });

        // Only the two that were not already watched.
        expect(h.marked.map(m => m.path)).toEqual([
            `/UserPlayedItems/${episodeId(2)}`,
            `/UserPlayedItems/${episodeId(3)}`
        ]);
    });

    it('is a no-op when the item is already in that state', async () => {
        const h = harness({ item: { Id: MOVIE, Name: 'Alien', Type: 'Movie', UserData: { Played: true } } });
        const { structuredContent } = await h.call({ item_id: MOVIE, watched: true });

        expect(structuredContent.noop).toBe(true);
        expect(structuredContent.confirm_token).toBeUndefined();
    });

    it('is a no-op when every episode of the season is already watched', async () => {
        const h = harness({ episodes: [episode(1, true), episode(2, true)] });
        const { structuredContent } = await h.call({ item_id: SERIES, season: 2, watched: true });

        expect(structuredContent.noop).toBe(true);
    });

    it('refuses an id that is not a Jellyfin item', async () => {
        // A Radarr id is a small integer. Sending it on would 404 from
        // somewhere deep in the adapter, naming nothing useful.
        const h = harness();
        await expect(h.call({ item_id: '12', watched: true })).rejects.toThrow(/get_playback/);
    });

    it('refuses a season on something that is not a series', async () => {
        const h = harness();
        await expect(h.call({ item_id: MOVIE, season: 1, watched: true })).rejects.toThrow(/season/i);
    });

    it('says that re-marking does not restore the original play date', async () => {
        const h = harness();
        const { structuredContent } = await h.call({ item_id: MOVIE, watched: true });
        expect(structuredContent.effects.join(' ')).toMatch(/play (date|position)|when you watched/i);
    });

    it('names the config key when the permission is off', async () => {
        const h = harness({ config: jellyfinConfig({ permissions: { safe_write: false, destructive: false } }) });
        await expect(h.call({ item_id: MOVIE, watched: true })).rejects.toThrow(/safe_write/);
    });

    it('writes an audit row on every branch', async () => {
        const h = harness();
        expect((await h.call({ item_id: MOVIE, watched: true })).structuredContent.audit_id).toBeDefined();

        const denied = harness({ config: jellyfinConfig({ permissions: { safe_write: false, destructive: false } }) });
        await expect(denied.call({ item_id: MOVIE, watched: true })).rejects.toThrow();
        expect(denied.audit.recent(10)).toHaveLength(1);
    });
});
