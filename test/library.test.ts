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

    // Whole-phase review item 5: no-user-configured is a configuration error
    // with an actionable remedy, not a reachability problem — src/config/schema.ts
    // documents that "a per-user tool called with nothing configured fails
    // naming this key." Before this fix, #resolveUser only propagated NotFound
    // when `requested !== undefined`, so this exact case (nobody named,
    // nothing configured) degraded silently and permanently: every call
    // reported "jellyfin could not be reached" forever, indistinguishable
    // from a real, self-healing outage, while stack_health kept calling
    // Jellyfin healthy.
    it('fails naming default_user, rather than degrading forever, when no Jellyfin user is configured and none was requested', async () => {
        const noDefault = identity(
            new ServiceError('NotFound', 'jellyfin', 'no user was named and none is configured', {
                remedy: 'Set services.jellyfin.default_user in config.yaml, or pass a user explicitly.'
            })
        );
        const loader = new LibraryLoader([radarr(), jellyfin({})], noDefault);
        await expect(loader.load()).rejects.toThrow(/default_user/);
    });

    it('fails naming default_user the same way when a configured default_user does not match any real Jellyfin user', async () => {
        // A different NotFound path through IdentityResolver.resolve (not
        // #authorize): `default_user` is configured, but is a typo or a
        // deleted account, so the directory lookup itself comes up empty.
        // `requested` (the argument to #resolveUser) is still undefined here
        // — nobody named anyone, the *default* was used internally — so this
        // is the other case the old `requested !== undefined` check missed.
        const badDefault = identity(new ServiceError('NotFound', 'jellyfin', 'no user named "Bartsu"'));
        const loader = new LibraryLoader([radarr(), jellyfin({})], badDefault);
        await expect(loader.load()).rejects.toThrow(/no user named/);
    });

    it('still propagates AuthFailed rather than degrading — a refusal is not a configuration gap', async () => {
        // Guards the boundary the two tests above sit next to: AuthFailed and
        // NotFound must not collapse into the same handling just because both
        // now propagate. AuthFailed means a *configured* default exists and a
        // different user was asked for and refused — never a case for
        // "set default_user", and never a case for degrading either.
        const refused = identity(new ServiceError('AuthFailed', 'jellyfin', 'not permitted to query as "Someone Else"'));
        const loader = new LibraryLoader([radarr(), jellyfin({})], refused);
        await expect(loader.load('Someone Else')).rejects.toThrow(/not permitted/);
    });

    it('degrades rather than fails when Jellyfin is unreachable, even with a user named', async () => {
        // Naming a user must not turn a plain outage into a hard failure of
        // the whole library read — the *arr half is still worth returning.
        // Before this fix, #resolveUser propagated on `requested !== undefined`
        // alone, so this exact case (a named user, an Unreachable error) threw.
        const down = identity(new ServiceError('Unreachable', 'jellyfin', 'connection refused'));
        const snapshot = await new LibraryLoader([radarr(), jellyfin({})], down).load('Someone');

        expect(snapshot.index.size()).toBe(1);
        expect(snapshot.degraded).toEqual(['jellyfin']);
    });

    it('propagates when an explicitly named user does not exist', async () => {
        // Unlike the no-default-configured case above, a user *was* named —
        // degrading here would silently answer as if nobody had asked.
        const ghost = identity(new ServiceError('NotFound', 'jellyfin', 'no user named "Ghost"'));
        const loader = new LibraryLoader([radarr(), jellyfin({})], ghost);
        await expect(loader.load('Ghost')).rejects.toThrow(/no user named/);
    });

    it('returns an empty index when nothing is configured', async () => {
        const snapshot = await new LibraryLoader([], undefined).load();
        expect(snapshot.index.size()).toBe(0);
        expect(snapshot.degraded).toEqual([]);
    });

    // Whole-phase review, item 1: presence must not assert arr_only across a
    // Jellyfin half this loader knows it never gathered — degraded or
    // unconfigured alike. Reproduced against LibraryLoader (not just
    // LibraryIndex directly) because it is this class that has to notice.
    describe('presence honesty when Jellyfin cannot contribute (item 1)', () => {
        it('reports every *arr item as unknown, not arr_only, when Jellyfin is configured but degraded', async () => {
            const broken = stub('jellyfin', {
                listUserLibrary: async () => {
                    throw new ServiceError('Unreachable', 'jellyfin', 'connection refused');
                }
            });
            const snapshot = await new LibraryLoader([radarr(), broken], identity(someone)).load();

            expect(snapshot.degraded).toEqual(['jellyfin']);
            expect(snapshot.index.find({ tmdb: 550 })?.presence).toBe('unknown');
        });

        it('reports every *arr item as unknown, not arr_only, when Jellyfin is not configured at all', async () => {
            // No jellyfin adapter at all — get_library's arr_only claim ("Jellyfin
            // cannot see it") would be nonsensical here: there is no Jellyfin.
            const snapshot = await new LibraryLoader([radarr()], undefined).load();

            expect(snapshot.index.find({ tmdb: 550 })?.presence).toBe('unknown');
        });

        it('still reports arr_only when Jellyfin is configured and healthy — the fix must not blunt the real signal', async () => {
            const snapshot = await new LibraryLoader(
                [radarr(), jellyfin({ Someone: [] })],
                identity(someone)
            ).load();

            expect(snapshot.degraded).toEqual([]);
            expect(snapshot.index.find({ tmdb: 550 })?.presence).toBe('arr_only');
        });
    });
});
