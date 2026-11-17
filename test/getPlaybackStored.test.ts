import { describe, expect, it, vi } from 'vitest';
import type { IdentityResolver } from '../src/core/identity.ts';
import { PlayHistory } from '../src/core/playHistory.ts';
import type { MediaServerAdapter, PlaybackEntry } from '../src/services/types.ts';
import { buildGetPlayback } from '../src/tools/getPlayback.ts';

const user = { id: 'u1', name: 'Sam' };
const identity = { resolve: vi.fn(async () => user) } as unknown as IdentityResolver;

const play = (itemId: string, title: string, lastPlayed?: string, extra: Partial<PlaybackEntry> = {}): PlaybackEntry => ({
    service: 'jellyfin',
    kind: 'watched',
    itemId,
    title,
    user: 'Sam',
    ...(lastPlayed === undefined ? {} : { lastPlayed }),
    ...extra
});

const serverReturning = (history: PlaybackEntry[]) =>
    ({ id: 'jellyfin', type: 'jellyfin', getWatchHistory: async () => history }) as unknown as MediaServerAdapter;

const history = (adapter: MediaServerAdapter, plays?: PlayHistory) =>
    buildGetPlayback(adapter, identity, { detail: 'full', limit: 50, scope: 'history' }, plays);

describe('get_playback history with a play store', () => {
    it('adds a stored play the server no longer returns, in date order', async () => {
        const plays = PlayHistory.ephemeral();
        plays.record('jellyfin', user, [{ entry: play('gone', 'Gone', '2025-06-01T00:00:00.000Z'), kind: 'movie' }]);

        const result = await history(
            serverReturning([play('new', 'New', '2026-01-01T00:00:00.000Z'), play('older', 'Older', '2024-01-01T00:00:00.000Z')]),
            plays
        );
        expect(result.items.map(i => i.itemId)).toEqual(['new', 'gone', 'older']);
        expect(result.total).toBe(3);
    });

    it("returns the server's row, not the stored one, when both have the item", async () => {
        const plays = PlayHistory.ephemeral();
        plays.record('jellyfin', user, [{ entry: play('a', 'Old title', '2025-01-01T00:00:00.000Z'), kind: 'movie' }]);
        const result = await history(serverReturning([play('a', 'New title', '2026-01-01T00:00:00.000Z')]), plays);
        expect(result.items).toHaveLength(1);
        expect(result.items[0]?.title).toBe('New title');
    });

    it('records what it read, so the next read keeps it after the server drops it', async () => {
        const plays = PlayHistory.ephemeral();
        await history(serverReturning([play('a', 'Alpha', '2026-01-01T00:00:00.000Z')]), plays);
        const result = await history(serverReturning([]), plays);
        expect(result.items.map(i => i.itemId)).toEqual(['a']);
    });

    it('does not repeat a Plex row for a deleted item, which has no item id', async () => {
        const plays = PlayHistory.ephemeral();
        const deleted = play('', 'Deleted film', '2026-01-01T00:00:00.000Z');
        await history(serverReturning([deleted]), plays);
        const result = await history(serverReturning([deleted]), plays);
        expect(result.items).toHaveLength(1);
    });

    it('returns what the server said when the store fails', async () => {
        const plays = PlayHistory.ephemeral();
        plays.close();
        const result = await history(serverReturning([play('a', 'Alpha')]), plays);
        expect(result.items.map(i => i.itemId)).toEqual(['a']);
        expect(result.degraded).toEqual([]);
    });

    it('leaves the other scopes alone', async () => {
        const plays = PlayHistory.ephemeral();
        plays.record('jellyfin', user, [{ entry: play('gone', 'Gone'), kind: 'movie' }]);
        const adapter = { id: 'jellyfin', type: 'jellyfin', getPlayback: async () => [] } as unknown as MediaServerAdapter;
        const result = await buildGetPlayback(adapter, identity, { detail: 'full', limit: 50, scope: 'active' }, plays);
        expect(result.items).toEqual([]);
    });
});
