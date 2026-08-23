import { describe, expect, it, vi } from 'vitest';
import type { KeyedServiceConfig } from '../src/config/schema.ts';
import { TtlCache } from '../src/core/cache.ts';
import { ServiceError } from '../src/core/errors.ts';
import type { IdentityResolver } from '../src/core/identity.ts';
import type { IndexInput } from '../src/core/resolver.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import { LibraryLoader } from '../src/tools/library.ts';
import type { ServiceAdapter, ServiceUser } from '../src/services/types.ts';

/** A hand-cranked clock, so expiry is testable without waiting real seconds. */
const clock = (start = 0) => {
    let now = start;
    return { now: () => now, advance: (ms: number) => (now += ms) };
};

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

const identity = (user: ServiceUser | Error, hasDefaultUser = true): IdentityResolver =>
    ({
        resolve: async (requested?: string) => {
            if (user instanceof Error) throw user;
            if (requested !== undefined && requested !== user.name) {
                throw new ServiceError('AuthFailed', 'jellyfin', `not permitted to query as "${requested}"`);
            }
            return user;
        },
        hasDefaultUser
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

    // A real adapter, not a stub: `invalidate` clearing only the join cache
    // would pass this with a spy on `invalidateLibrary`, but a stale reply
    // sitting under the adapter's own cache would leak straight past the
    // join being cleared. Counting the actual upstream reads is what proves
    // the adapter cache was cleared too, not just called.
    it('reads upstream again after invalidate, not just past the join cache', async () => {
        const radarrConfig: KeyedServiceConfig = {
            url: 'http://192.0.2.10:7878',
            api_key: 'k',
            timeout_ms: 10_000,
            permissions: { safe_write: false, destructive: false }
        };
        let fetches = 0;
        const fetchImpl = (async () => {
            fetches += 1;
            return new Response(JSON.stringify([{ id: 1, title: 'Some Film', year: 2026, tmdbId: 550 }]), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        }) as unknown as typeof fetch;

        const loader = new LibraryLoader([new RadarrAdapter(radarrConfig, fetchImpl)], undefined);

        await loader.load();
        loader.invalidate();
        await loader.load();

        expect(fetches).toBe(2);
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

    it('recovers past the short degraded ttl, once the service is back', async () => {
        const c = clock();
        let calls = 0;
        const flaky = stub('radarr', {
            listLibrary: async () => {
                calls += 1;
                if (calls === 1) throw new ServiceError('Unreachable', 'radarr', 'restarting');
                return [film(550)];
            }
        });
        const loader = new LibraryLoader([flaky], undefined, new TtlCache(c.now));

        expect((await loader.load()).degraded).toEqual(['radarr']);
        c.advance(25_000);
        expect((await loader.load()).index.size()).toBe(1);
    });

    it('caches a degraded snapshot briefly rather than not at all', async () => {
        const c = clock();
        let calls = 0;
        const flaky = stub('radarr', {
            listLibrary: async () => {
                calls += 1;
                return [film(550)];
            }
        });
        const broken = stub('sonarr', {
            listLibrary: async () => {
                throw new ServiceError('Unreachable', 'sonarr', 'connection refused');
            }
        });
        const loader = new LibraryLoader([flaky, broken], undefined, new TtlCache(c.now));

        await loader.load();
        await loader.load();
        expect(calls).toBe(1);

        c.advance(25_000);
        await loader.load();
        expect(calls).toBe(2);
    });

    it('still gives a complete snapshot the full TTL', async () => {
        const c = clock();
        let calls = 0;
        const counted = stub('radarr', {
            listLibrary: async () => {
                calls += 1;
                return [film(550)];
            }
        });
        const loader = new LibraryLoader([counted], undefined, new TtlCache(c.now));

        await loader.load();
        c.advance(25_000);
        await loader.load();
        expect(calls).toBe(1);
    });

    it('propagates an authorization refusal instead of degrading', async () => {
        // A model told "Jellyfin is down" when it was refused will retry
        // forever; one told it was refused will not.
        const loader = new LibraryLoader([radarr(), jellyfin({})], identity(someone));
        await expect(loader.load('Someone Else')).rejects.toThrow(/not permitted/);
    });

    // Whole-phase review item 5, revised: no-user-configured is a
    // configuration gap with an actionable remedy, not a reachability
    // problem — but it is also not a reason to lose the Radarr and Sonarr
    // halves of a read that never needed a Jellyfin user. Before this fix,
    // #resolveUser propagated NotFound whenever `requested === undefined`,
    // so this exact case (nobody named, nothing configured) threw and the
    // whole read failed, even though the schema explicitly allows Jellyfin
    // to be configured with no `default_user` (present only in stack_health).
    it('degrades to the arrs, with a note naming default_user, when no Jellyfin user is configured and none was requested', async () => {
        const noDefault = identity(
            new ServiceError('NotFound', 'jellyfin', 'no user was named and none is configured', {
                remedy: 'Set services.jellyfin.default_user in config.yaml, or pass a user explicitly.'
            }),
            false
        );
        const loader = new LibraryLoader([radarr(), jellyfin({})], noDefault);

        const snapshot = await loader.load();

        // The Radarr half is the point: a config choice the schema explicitly
        // allows must not lose it.
        expect(snapshot.index.size()).toBeGreaterThan(0);
        expect(snapshot.degraded).toContain('jellyfin');
        expect(snapshot.note).toContain('default_user');
    });

    it('propagates when a configured default_user does not match any real Jellyfin user', async () => {
        // A different NotFound path through IdentityResolver.resolve (not
        // #authorize): `default_user` is configured, but is a typo or a
        // deleted account, so the directory lookup itself comes up empty.
        // `requested` (the argument to #resolveUser) is still undefined here
        // — nobody named anyone, the *default* was used internally — but a
        // *wrong* default_user is a config error, not the "nothing
        // configured" case the spec blesses for degrading, so this must
        // still throw the actionable error naming the bad value.
        const badDefault = identity(new ServiceError('NotFound', 'jellyfin', 'no user named "Bartsu"'), true);
        const loader = new LibraryLoader([radarr(), jellyfin({})], badDefault);

        await expect(loader.load()).rejects.toThrow(/no user named "Bartsu"/);
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

const seasonsOf = (tvdb: number): IndexInput => ({
    kind: 'series',
    title: 'Some Show',
    ids: { tvdb },
    seasons: [{ season: 1, watched: 8 }]
});

/** Sonarr's half of a season row: the denominators, and no watch state. */
const sonarrShow = (tvdb: number): IndexInput => ({
    kind: 'series',
    title: 'Some Show',
    ids: { tvdb },
    acquisition: { service: 'sonarr', monitored: true, hasFile: true },
    seasons: [{ season: 1, onDisk: 8, aired: 8, total: 10 }]
});

const sonarr = (items = [sonarrShow(292157)]) => stub('sonarr', { listLibrary: async () => items });

const jellyfinWithSeasons = (byUser: Record<string, IndexInput[]>, seasons: IndexInput[] | Error) =>
    stub('jellyfin', {
        listUserLibrary: async (u: ServiceUser) => byUser[u.name] ?? [],
        listUserSeasons: async () => {
            if (seasons instanceof Error) throw seasons;
            return seasons;
        }
    });

describe('the jellyfin:episodes source', () => {
    it('adds seasons to the merged item', async () => {
        const loader = new LibraryLoader(
            [jellyfinWithSeasons({ Someone: [watched(550, 'Someone')] }, [seasonsOf(292157)])],
            identity(someone)
        );
        const snapshot = await loader.load();
        expect(snapshot.index.find({ tvdb: 292157 })?.seasons).toEqual([{ season: 1, watched: 8 }]);
    });

    it('degrades on its own name, leaving Jellyfin itself healthy', async () => {
        // The whole point of a separate source: an episode-endpoint failure
        // must not cost the caller their film watch state.
        const loader = new LibraryLoader(
            [
                radarr(),
                jellyfinWithSeasons({ Someone: [watched(550, 'Someone')] }, new Error('boom'))
            ],
            identity(someone)
        );
        const snapshot = await loader.load();

        expect(snapshot.degraded).toContain('jellyfin:episodes');
        expect(snapshot.degraded).not.toContain('jellyfin');
        expect(snapshot.index.find({ tmdb: 550 })?.presence).toBe('both');
        expect(snapshot.index.find({ tmdb: 550 })?.playback?.watched).toBe(true);
    });

    it('leaves Sonarr’s half of seasons intact when the episode read fails', async () => {
        // Not "season data goes missing": the denominators come from Sonarr's
        // own library read, which this failure never touched. Only the watch
        // half and `complete`, which needs both halves to be computed at all,
        // are absent — and absent, never `false`/`0`.
        const loader = new LibraryLoader(
            [sonarr(), jellyfinWithSeasons({ Someone: [] }, new Error('boom'))],
            identity(someone)
        );
        const snapshot = await loader.load();
        const seasons = snapshot.index.find({ tvdb: 292157 }, 'series')?.seasons;

        expect(snapshot.degraded).toEqual(['jellyfin:episodes']);
        expect(seasons).toEqual([{ season: 1, onDisk: 8, aired: 8, total: 10 }]);
        expect(seasons?.[0]).not.toHaveProperty('watched');
        expect(seasons?.[0]).not.toHaveProperty('complete');
    });

    it('is not registered when the adapter cannot answer it', async () => {
        const loader = new LibraryLoader([radarr()], undefined);
        expect((await loader.load()).counts).not.toHaveProperty('jellyfin:episodes');
    });
});
