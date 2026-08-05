import { describe, expect, it, vi } from 'vitest';
import { ServiceError } from '../src/core/errors.ts';
import type { IdentityResolver } from '../src/core/identity.ts';
import type { IndexInput } from '../src/core/resolver.ts';
import { LibraryLoader } from '../src/tools/library.ts';
import type { ServiceAdapter, ServiceUser } from '../src/services/types.ts';

const film = (tmdb: number): IndexInput => ({
    kind: 'movie',
    title: 'Some Film',
    ids: { tmdb },
    acquisition: { service: 'radarr', monitored: true, hasFile: true }
});

const watched = (tmdb: number, user: string): IndexInput => ({
    kind: 'movie',
    title: 'Some Film',
    ids: { tmdb },
    playback: { user, watched: true }
});

const stub = (id: ServiceAdapter['id'], extra: Record<string, unknown>): ServiceAdapter =>
    ({
        id,
        testConnection: async () => ({ ok: true, service: id, latency_ms: 1 }),
        getVersion: async () => '1.0.0',
        ...extra
    }) as unknown as ServiceAdapter;

const radarr = (items = [film(550)]) => stub('radarr', { listLibrary: async () => items });
const jellyfin = (byUser: Record<string, IndexInput[]>) =>
    stub('jellyfin', { listUserLibrary: async (u: ServiceUser) => byUser[u.name] ?? [] });

const identity = (user: ServiceUser | Error): IdentityResolver =>
    ({
        resolve: async (requested?: string) => {
            if (user instanceof Error) throw user;
            if (requested !== undefined && requested !== user.name) {
                throw new ServiceError('AuthFailed', 'jellyfin', `not permitted to query as "${requested}"`);
            }
            return user;
        }
    }) as unknown as IdentityResolver;

const someone = { id: 'u1', name: 'Someone' };

describe('LibraryLoader', () => {
    it('merges the *arr and Jellyfin halves into one index', async () => {
        const loader = new LibraryLoader(
            [radarr(), jellyfin({ Someone: [watched(550, 'Someone')] })],
            identity(someone)
        );

        const snapshot = await loader.load();
        expect(snapshot.index.size()).toBe(1);
        expect(snapshot.index.find({ tmdb: 550 })?.presence).toBe('both');
    });

    it('reports per-service counts, so a missing half is visible', async () => {
        const loader = new LibraryLoader(
            [radarr(), jellyfin({ Someone: [watched(550, 'Someone')] })],
            identity(someone)
        );
        expect((await loader.load()).counts).toEqual({ radarr: 1, jellyfin: 1 });
    });

    it('serves a second call from the cache', async () => {
        const listLibrary = vi.fn(async () => [film(550)]);
        const loader = new LibraryLoader([stub('radarr', { listLibrary })], undefined);

        await loader.load();
        await loader.load();

        expect(listLibrary).toHaveBeenCalledTimes(1);
    });

    it('caches per Jellyfin user, so one household member cannot see another', async () => {
        const byUser = { Someone: [watched(550, 'Someone')], Other: [] };
        const resolve = vi.fn(async (requested?: string) => ({ id: `id-${requested}`, name: requested ?? 'Someone' }));
        const loader = new LibraryLoader([radarr(), jellyfin(byUser)], {
            resolve
        } as unknown as IdentityResolver);

        const mine = await loader.load('Someone');
        const theirs = await loader.load('Other');

        expect(mine.index.find({ tmdb: 550 })?.playback?.watched).toBe(true);
        // Not merely a different answer: the other user's entry must be absent,
        // not present-and-false, or the cache key is doing nothing.
        expect(theirs.index.find({ tmdb: 550 })?.playback).toBeUndefined();
    });

    it('degrades when one service fails rather than failing the call', async () => {
        const broken = stub('sonarr', {
            listLibrary: async () => {
                throw new ServiceError('Unreachable', 'sonarr', 'connection refused');
            }
        });
        const snapshot = await new LibraryLoader([radarr(), broken], undefined).load();

        expect(snapshot.index.size()).toBe(1);
        expect(snapshot.degraded).toEqual(['sonarr']);
        expect(snapshot.counts.sonarr).toBeUndefined();
    });

    it('does not cache a degraded load, so a restarted service recovers', async () => {
        let calls = 0;
        const flaky = stub('radarr', {
            listLibrary: async () => {
                calls += 1;
                if (calls === 1) throw new ServiceError('Unreachable', 'radarr', 'restarting');
                return [film(550)];
            }
        });
        const loader = new LibraryLoader([flaky], undefined);

        expect((await loader.load()).degraded).toEqual(['radarr']);
        expect((await loader.load()).index.size()).toBe(1);
    });

    it('propagates an authorization refusal instead of degrading', async () => {
        // A model told "Jellyfin is down" when it was refused will retry
        // forever; one told it was refused will not.
        const loader = new LibraryLoader([radarr(), jellyfin({})], identity(someone));
        await expect(loader.load('Someone Else')).rejects.toThrow(/not permitted/);
    });

    it('builds the *arr half alone when no Jellyfin user is configured', async () => {
        const noDefault = identity(
            new ServiceError('NotFound', 'jellyfin', 'no user was named and none is configured')
        );
        const snapshot = await new LibraryLoader([radarr(), jellyfin({})], noDefault).load();

        expect(snapshot.index.size()).toBe(1);
        expect(snapshot.degraded).toEqual(['jellyfin']);
    });

    it('returns an empty index when nothing is configured', async () => {
        const snapshot = await new LibraryLoader([], undefined).load();
        expect(snapshot.index.size()).toBe(0);
        expect(snapshot.degraded).toEqual([]);
    });
});
