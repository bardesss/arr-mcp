import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IdentityResolver } from '../src/core/identity.ts';
import { PlayHistory } from '../src/core/playHistory.ts';
import { startPlaySync, syncPlays } from '../src/core/playSync.ts';
import type { MediaServerAdapter } from '../src/services/types.ts';
import type { MediaServers } from '../src/tools/mediaServers.ts';

const user = { id: 'u1', name: 'Sam' };

const choice = (id: string, opts: { fail?: boolean } = {}) => {
    const getWatchHistory = vi.fn(async () => {
        if (opts.fail === true) throw new Error('down');
        return [{ service: id, kind: 'watched', itemId: `${id}-1`, title: 'Alpha', user: 'Sam' }];
    });
    return {
        adapter: { id, type: id, getWatchHistory, listUserLibrary: vi.fn(async () => []) } as unknown as MediaServerAdapter,
        identity: { resolve: vi.fn(async () => user) } as unknown as IdentityResolver,
        getWatchHistory
    };
};

const pick = ({ adapter, identity }: ReturnType<typeof choice>) => ({ adapter, identity });

afterEach(() => {
    vi.useRealTimers();
});

describe('syncPlays', () => {
    it('records each media server under its own id', async () => {
        const store = PlayHistory.ephemeral();
        await syncPlays({ primary: pick(choice('jellyfin')), secondary: pick(choice('plex')) }, store);
        expect(store.read('jellyfin', 'u1').map(r => r.entry.itemId)).toEqual(['jellyfin-1']);
        expect(store.read('plex', 'u1').map(r => r.entry.itemId)).toEqual(['plex-1']);
    });

    it('still records the other server when one fails', async () => {
        const store = PlayHistory.ephemeral();
        await syncPlays({ primary: pick(choice('jellyfin', { fail: true })), secondary: pick(choice('plex')) }, store);
        expect(store.read('jellyfin', 'u1')).toEqual([]);
        expect(store.read('plex', 'u1')).toHaveLength(1);
    });

    it('adds to the stored Plex rows instead of replacing them when the full read stopped at its backstop', async () => {
        const store = PlayHistory.ephemeral();
        store.record('plex', user, [{ entry: { service: 'plex', kind: 'watched', itemId: 'old', title: 'Older', user: 'Sam' }, kind: 'movie' }]);
        const plex = choice('plex');
        plex.getWatchHistory.mockImplementationOnce((async (_user: unknown, opts?: { onTruncated?: () => void }) => {
            opts?.onTruncated?.();
            return [{ service: 'plex', kind: 'watched', itemId: 'plex-1', title: 'Alpha', user: 'Sam' }];
        }) as never);

        await syncPlays({ primary: pick(plex) }, store);
        expect(store.read('plex', 'u1').map(r => r.entry.itemId).sort()).toEqual(['old', 'plex-1']);
        expect(store.needsBackfill('plex', 'u1')).toBe(false);
    });

    it('reads the whole history on the first run only, and again after a failed first run', async () => {
        const store = PlayHistory.ephemeral();
        const flaky = choice('jellyfin', { fail: true });
        await syncPlays({ primary: pick(flaky) }, store);
        expect(store.needsBackfill('jellyfin', 'u1')).toBe(true);

        const server = choice('jellyfin');
        await syncPlays({ primary: pick(server) }, store);
        await syncPlays({ primary: pick(server) }, store);
        expect(server.getWatchHistory.mock.calls.map(c => (c as unknown[])[1])).toEqual([{ full: true, onTruncated: expect.any(Function) }, {}]);
    });

    it("rebuilds a Plex server's rows from its full read, and keeps Jellyfin's", async () => {
        const store = PlayHistory.ephemeral();
        const stale = (id: string) => ({ entry: { service: id, kind: 'watched' as const, itemId: 'old', title: 'A Song', user: 'Sam' }, kind: 'episode' as const });
        store.record('plex', user, [stale('plex')]);
        store.record('jellyfin', user, [stale('jellyfin')]);

        await syncPlays({ primary: pick(choice('jellyfin')), secondary: pick(choice('plex')) }, store);
        expect(store.read('plex', 'u1').map(r => r.entry.itemId)).toEqual(['plex-1']);
        expect(store.read('jellyfin', 'u1').map(r => r.entry.itemId).sort()).toEqual(['jellyfin-1', 'old']);
    });

    it('skips a server with no identity config', async () => {
        const store = PlayHistory.ephemeral();
        const bare = choice('jellyfin');
        await syncPlays({ primary: { adapter: bare.adapter, identity: undefined } }, store);
        expect(bare.getWatchHistory).not.toHaveBeenCalled();
    });
});

describe('startPlaySync', () => {
    it('runs after the first delay, then on the interval, reading the servers each time', async () => {
        vi.useFakeTimers();
        const store = PlayHistory.ephemeral();
        const server = (id: string): MediaServers => {
            const { adapter, identity } = choice(id);
            return { primary: { adapter, identity } };
        };
        let servers = server('jellyfin');
        const stop = startPlaySync(() => servers, store, { firstMs: 10, intervalMs: 100 });

        await vi.advanceTimersByTimeAsync(9);
        expect(store.read('jellyfin', 'u1')).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(store.read('jellyfin', 'u1')).toHaveLength(1);

        servers = server('plex');
        await vi.advanceTimersByTimeAsync(100);
        expect(store.read('plex', 'u1')).toHaveLength(1);
        await stop();
    });

    it('runs nothing after stop', async () => {
        vi.useFakeTimers();
        const primary = choice('jellyfin');
        const stop = startPlaySync(() => ({ primary: { adapter: primary.adapter, identity: primary.identity } }), PlayHistory.ephemeral(), { firstMs: 10 });
        await stop();
        await vi.advanceTimersByTimeAsync(1000);
        expect(primary.getWatchHistory).not.toHaveBeenCalled();
    });
});
