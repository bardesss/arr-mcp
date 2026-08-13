import { describe, expect, it, vi } from 'vitest';
import type { MultiUserServiceConfig } from '../src/config/schema.ts';
import { IdentityResolver } from '../src/core/identity.ts';
import { JellyfinAdapter } from '../src/services/jellyfin.ts';
import { SeerrAdapter } from '../src/services/seerr.ts';
import { buildGetPlayback } from '../src/tools/getPlayback.ts';
import { buildGetRequests } from '../src/tools/getRequests.ts';
import { repeat } from './helpers/bigFixture.ts';
import { expectWithinBudget } from './helpers/budget.ts';
import { serving } from './helpers/serve.ts';

const TICKS = 10_000_000;
const USER_ID = 'f137a2dd21bbc1b99aa5c0f6bf02a805';
const GUEST_ID = '0d8bc4b2ad1c4f6e8b7a3c9d5e1f2a3b';

const jellyfinConfig = (over: Partial<MultiUserServiceConfig> = {}): MultiUserServiceConfig => ({
    url: 'http://192.0.2.10:8096',
    api_key: 'k',
    timeout_ms: 10_000,
    allow_other_users: false,
    default_user: 'Bartus',
    permissions: { safe_write: false, destructive: false },
    ...over
});

const USERS = [
    { Id: USER_ID, Name: 'Bartus' },
    { Id: GUEST_ID, Name: 'Guest' }
];

const SESSIONS = [
    {
        UserId: USER_ID,
        UserName: 'Bartus',
        DeviceName: 'Living Room TV',
        NowPlayingItem: {
            Id: 'item-1',
            Name: 'Pilot',
            SeriesName: 'Some Show',
            ParentIndexNumber: 1,
            IndexNumber: 1,
            RunTimeTicks: 2700 * TICKS
        },
        PlayState: { PositionTicks: 600 * TICKS }
    },
    { UserId: 'someone-else', UserName: 'Guest', DeviceName: 'Phone', NowPlayingItem: { Id: 'item-9', Name: 'Other' } }
];

const RESUME = {
    Items: [
        {
            Id: 'item-2',
            Name: 'Some Film',
            RunTimeTicks: 7200 * TICKS,
            UserData: { PlaybackPositionTicks: 1800 * TICKS, LastPlayedDate: '2026-08-04T21:30:00Z' }
        }
    ]
};

const jellyfinRoutes = {
    '/Users': USERS,
    '/Sessions': SESSIONS,
    [`/Users/${USER_ID}/Items/Resume?Limit=500`]: RESUME
};

const jellyfin = (over: Partial<MultiUserServiceConfig> = {}, routes: Record<string, unknown> = jellyfinRoutes) => {
    const config = jellyfinConfig(over);
    const adapter = new JellyfinAdapter(config, serving(routes));
    return { adapter, resolver: new IdentityResolver(adapter, config) };
};

describe('get_playback', () => {
    it('returns what the configured user is watching now', async () => {
        const { adapter, resolver } = jellyfin();
        const result = await buildGetPlayback(adapter, resolver, { detail: 'full', limit: 50 });

        expect(result.items.find(i => i.kind === 'now_playing')).toMatchObject({
            service: 'jellyfin',
            itemId: 'item-1',
            season: 1,
            episode: 1,
            user: 'Bartus',
            positionSeconds: 600,
            runtimeSeconds: 2700,
            device: 'Living Room TV'
        });
    });

    it('excludes other users sessions even though the admin key can see them', async () => {
        const { adapter, resolver } = jellyfin();
        const result = await buildGetPlayback(adapter, resolver, { detail: 'full', limit: 50 });
        expect(result.items.every(i => i.user === 'Bartus')).toBe(true);
    });

    it('returns continue-watching items with a completion percentage', async () => {
        const { adapter, resolver } = jellyfin();
        const result = await buildGetPlayback(adapter, resolver, { detail: 'full', limit: 50 });
        const resume = result.items.find(i => i.kind === 'resume');

        expect(resume).toMatchObject({ itemId: 'item-2', positionSeconds: 1800, runtimeSeconds: 7200 });
        expect(resume?.percentComplete).toBe(25);
    });

    it('omits the percentage rather than dividing by zero when runtime is unknown', async () => {
        const noRuntime = { Items: [{ Id: 'x', Name: 'X', UserData: { PlaybackPositionTicks: 100 } }] };
        const { adapter, resolver } = jellyfin({}, { ...jellyfinRoutes, [`/Users/${USER_ID}/Items/Resume?Limit=500`]: noRuntime });
        const result = await buildGetPlayback(adapter, resolver, { detail: 'full', limit: 50 });

        expect(result.items.find(i => i.kind === 'resume')?.percentComplete).toBeUndefined();
    });

    it('fences titles, which carry provider metadata we did not author', async () => {
        const { adapter, resolver } = jellyfin();
        const result = await buildGetPlayback(adapter, resolver, { detail: 'full', limit: 50 });
        expect(result.items.every(i => i.title.startsWith('<<untrusted:jellyfin.'))).toBe(true);
    });

    it('rejects another user before any network call when allow_other_users is false', async () => {
        const { adapter, resolver } = jellyfin();
        const listUsers = vi.fn();
        adapter.listUsers = listUsers;

        await expect(buildGetPlayback(adapter, resolver, { detail: 'full', limit: 50, user: 'Guest' })).rejects.toThrow(
            /auth failed/
        );
        expect(listUsers).not.toHaveBeenCalled();
    });

    it('permits another user when allow_other_users is true', async () => {
        const guestRoutes = { ...jellyfinRoutes, [`/Users/${GUEST_ID}/Items/Resume?Limit=500`]: { Items: [] } };
        const { adapter, resolver } = jellyfin({ allow_other_users: true }, guestRoutes);
        const result = await buildGetPlayback(adapter, resolver, { detail: 'full', limit: 50, user: 'Guest' });

        expect(result.degraded).toEqual([]);
        expect(result.items.every(i => i.user === 'Guest')).toBe(true);
    });

    it('names the config key when no default user is configured', async () => {
        const { adapter, resolver } = jellyfin({ default_user: undefined });
        const err = await buildGetPlayback(adapter, resolver, { detail: 'full', limit: 50 }).catch(e => e as Error);
        expect(String(err)).toMatch(/no user was named/);
    });

    it('degrades rather than failing when Jellyfin drops mid-call', async () => {
        const { adapter, resolver } = jellyfin({}, { '/Users': USERS });
        const result = await buildGetPlayback(adapter, resolver, { detail: 'standard', limit: 50 });

        expect(result.items).toEqual([]);
        expect(result.degraded).toEqual(['jellyfin']);
    });

    it('reports truncation honestly', async () => {
        const many = { Items: repeat(RESUME.Items[0]!, 200) };
        const { adapter, resolver } = jellyfin({}, { ...jellyfinRoutes, [`/Users/${USER_ID}/Items/Resume?Limit=500`]: many });
        const result = await buildGetPlayback(adapter, resolver, { detail: 'standard', limit: 50 });

        expect(result).toMatchObject({ total: 201, returned: 50, truncated: true });
    });

    it('stays within its token budget at the absolute maximum', async () => {
        const many = { Items: repeat(RESUME.Items[0]!, 500) };
        const { adapter, resolver } = jellyfin({}, { ...jellyfinRoutes, [`/Users/${USER_ID}/Items/Resume?Limit=500`]: many });
        const result = await buildGetPlayback(adapter, resolver, { detail: 'full', limit: 500 });

        expectWithinBudget(result, 40_000);
    });
});

const seerrConfig = (over: Partial<MultiUserServiceConfig> = {}): MultiUserServiceConfig => ({
    url: 'http://192.0.2.10:5055',
    api_key: 'k',
    timeout_ms: 10_000,
    allow_other_users: true,
    default_user: 'bartus',
    permissions: { safe_write: false, destructive: false },
    ...over
});

const SEERR_USERS = { results: [{ id: 1, displayName: 'bartus' }, { id: 2, displayName: 'guest' }] };

const REQUESTS = {
    results: [
        {
            id: 10,
            status: 1,
            createdAt: '2026-08-04T10:00:00Z',
            media: { tmdbId: 550, mediaType: 'movie', title: 'Fight Club' },
            requestedBy: { id: 1, displayName: 'bartus' }
        },
        {
            id: 11,
            status: 2,
            createdAt: '2026-08-03T10:00:00Z',
            media: { tmdbId: 1396, mediaType: 'tv', title: 'Breaking Bad' },
            requestedBy: { id: 2, displayName: 'guest' }
        },
        {
            id: 12,
            status: 3,
            createdAt: '2026-08-02T10:00:00Z',
            media: { tmdbId: 999, mediaType: 'movie' },
            requestedBy: { id: 1, displayName: 'bartus' }
        }
    ]
};

const seerrRoutes = { '/api/v1/user': SEERR_USERS, '/api/v1/request': REQUESTS };

const seerr = (over: Partial<MultiUserServiceConfig> = {}, routes: Record<string, unknown> = seerrRoutes) => {
    const config = seerrConfig(over);
    const adapter = new SeerrAdapter(config, serving(routes));
    return { adapter, resolver: new IdentityResolver(adapter, config) };
};

describe('get_requests', () => {
    it('maps numeric statuses to words', async () => {
        const { adapter, resolver } = seerr();
        const result = await buildGetRequests(adapter, resolver, { detail: 'full', limit: 50, user: 'bartus' });
        expect(result.items.map(i => i.status).sort()).toEqual(['declined', 'pending']);
    });

    it('scopes to the named user, filtering in the adapter if the server does not', async () => {
        const { adapter, resolver } = seerr();
        const result = await buildGetRequests(adapter, resolver, { detail: 'full', limit: 50, user: 'bartus' });

        expect(result.items.every(i => i.requestedBy === 'bartus')).toBe(true);
        expect(result.total).toBe(2);
    });

    it('defaults to the configured user when none is named', async () => {
        const { adapter, resolver } = seerr();
        const result = await buildGetRequests(adapter, resolver, { detail: 'full', limit: 50 });
        expect(result.items.every(i => i.requestedBy === 'bartus')).toBe(true);
    });

    it('filters by status when asked', async () => {
        const { adapter, resolver } = seerr();
        const result = await buildGetRequests(adapter, resolver, {
            detail: 'full',
            limit: 50,
            user: 'bartus',
            status: 'pending'
        });

        expect(result.items).toHaveLength(1);
        expect(result.items[0]?.id).toBe(10);
    });

    it('fences request titles, which come from TMDB rather than from us', async () => {
        const { adapter, resolver } = seerr();
        const result = await buildGetRequests(adapter, resolver, { detail: 'full', limit: 50, user: 'bartus' });
        expect(result.items.find(i => i.id === 10)?.title).toBe('<<untrusted:seerr.title>>Fight Club<</untrusted>>');
    });

    it('omits the title rather than inventing one when the media has none', async () => {
        const { adapter, resolver } = seerr();
        const result = await buildGetRequests(adapter, resolver, { detail: 'full', limit: 50, user: 'bartus' });
        expect(result.items.find(i => i.id === 12)?.title).toBeUndefined();
    });

    it('rejects another user before any network call when allow_other_users is false', async () => {
        const { adapter, resolver } = seerr({ allow_other_users: false });
        await expect(
            buildGetRequests(adapter, resolver, { detail: 'full', limit: 50, user: 'guest' })
        ).rejects.toThrow(/auth failed/);
    });

    it('reads another user when allow_other_users is true — the point of the setting', async () => {
        const { adapter, resolver } = seerr();
        const result = await buildGetRequests(adapter, resolver, { detail: 'full', limit: 50, user: 'guest' });

        expect(result.items).toHaveLength(1);
        expect(result.items[0]?.requestedBy).toBe('guest');
    });

    it('degrades rather than failing when Seerr is unreachable', async () => {
        const { adapter, resolver } = seerr({}, { '/api/v1/user': SEERR_USERS });
        const result = await buildGetRequests(adapter, resolver, { detail: 'standard', limit: 50 });

        expect(result.items).toEqual([]);
        expect(result.degraded).toEqual(['seerr']);
    });

    it('stays within its token budget at the absolute maximum', async () => {
        const many = { results: repeat(REQUESTS.results[0]!, 500).map((r, n) => ({ ...r, id: n })) };
        const { adapter, resolver } = seerr({}, { ...seerrRoutes, '/api/v1/request': many });
        const result = await buildGetRequests(adapter, resolver, { detail: 'full', limit: 500 });

        expectWithinBudget(result, 30_000);
    });

    it('filters by user in memory regardless of what the server did', async () => {
        // The guarantee that makes SEERR_FILTERS_SERVER_SIDE safe to flip:
        // a server that ignores requestedBy — this fake one always returns
        // both rows, however the request was routed — must not widen what a
        // user sees.
        const unfiltered = {
            results: [
                { id: 1, status: 2, media: { tmdbId: 1, mediaType: 'movie' }, requestedBy: { id: 1, displayName: 'Someone' } },
                { id: 2, status: 2, media: { tmdbId: 2, mediaType: 'movie' }, requestedBy: { id: 2, displayName: 'Other' } }
            ]
        };
        const config = seerrConfig();
        const adapter = new SeerrAdapter(config, serving({ '/api/v1/request': unfiltered }));

        const requests = await adapter.getRequests({ user: { id: '1', name: 'Someone' } });
        expect(requests.map(r => r.id)).toEqual([1]);
    });

    it('asks Seerr for a status it can filter on, rather than narrowing 500 rows in memory', async () => {
        // The window is the newest 500 by `added`. A household with 600
        // lifetime requests whose pending ones are older than that got an empty
        // list for `status: pending` — which reads as "nothing is pending"
        // rather than as a truncation.
        const urls: string[] = [];
        const impl = (async (input: string | URL | Request) => {
            urls.push(input instanceof Request ? input.url : String(input));
            return new Response(JSON.stringify({ results: [] }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        }) as unknown as typeof fetch;

        const adapter = new SeerrAdapter(seerrConfig(), impl);
        await adapter.getRequests({ status: 'pending' });
        expect(urls[0]).toContain('filter=pending');

        // Seerr's filter vocabulary has no value for declined, and mapping it
        // onto a near-miss would answer a different question.
        urls.length = 0;
        await adapter.getRequests({ status: 'declined' });
        expect(urls[0]).not.toContain('filter=');
    });
});
