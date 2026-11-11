import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServiceError } from '../src/core/errors.ts';
import type { MergedItem, SeasonSummary } from '../src/core/resolver.ts';
import type {
    CleanupCandidate,
    CleanupProtection,
    CleanupRemoval,
    CleanupStatus,
    MediaRequest,
    QueueItem,
    ServiceAdapter
} from '../src/services/types.ts';
import {
    CROSS_CHECK_BUDGET_MS,
    buildCrossChecker,
    type CrossCheckProfile,
    type CrossCheckSubject
} from '../src/tools/crossChecks.ts';
import { LibraryLoader } from '../src/tools/library.ts';

type Source<T> = T | Error | Promise<T>;
type World = {
    seerr?: Source<MediaRequest[]>;
    reclaimerr?: Source<CleanupStatus>;
    /** Queue rows by service id. */
    queues?: Record<string, Source<QueueItem[]>>;
    /** What the library holds for the subject; `null` for a miss, an Error for an outage. */
    library?: MergedItem | null | Error;
    /** The snapshot's own `degraded`, for a load that resolves while a source is down. */
    degraded?: string[];
    /** A library load that never answers. */
    libraryHangs?: boolean;
    /** Called with what Reclaimerr was asked. */
    asked?: (kind: string, tmdb: number) => void;
    /** Collects what Seerr was asked: `list`, or `<type>:<tmdb id>` for one title. */
    seerrAsked?: string[];
    /** What a title lookup throws instead of answering. */
    titleError?: Error;
};

const settle = async <T>(source: Source<T>): Promise<T> => {
    const value = await source;
    if (value instanceof Error) throw value;
    return value;
};

const stub = (id: string, extra: Record<string, unknown>): ServiceAdapter => ({ id, type: id, ...extra }) as unknown as ServiceAdapter;

function adaptersFor(world: World): ServiceAdapter[] {
    const adapters: ServiceAdapter[] = [];
    if (world.seerr !== undefined) {
        const source = world.seerr;
        const asked = world.seerrAsked;
        adapters.push(
            stub(
                'seerr',
                asked === undefined
                    ? { getRequests: () => settle(source) }
                    : {
                          getRequests: () => {
                              asked.push('list');
                              return settle(source);
                          },
                          getMediaRequests: (t: string, id: number) => {
                              asked.push(`${t}:${id}`);
                              if (world.titleError !== undefined) return Promise.reject(world.titleError);
                              return settle(source).then(requests => ({ requests }));
                          }
                      }
            )
        );
    }
    if (world.reclaimerr !== undefined) {
        const source = world.reclaimerr;
        adapters.push(
            stub('reclaimerr', {
                readCleanupStatus: (kind: string, tmdb: number) => {
                    world.asked?.(kind, tmdb);
                    return settle(source);
                }
            })
        );
    }
    for (const [id, source] of Object.entries(world.queues ?? {})) {
        adapters.push(stub(id, { getQueue: () => settle(source), ...(id === 'lidarr' ? { queueKind: 'artist' } : id === 'radarr' ? { queueKind: 'movie' } : {}) }));
    }
    return adapters;
}

function libraryFor(world: World): LibraryLoader {
    const hit = world.library ?? undefined;
    return {
        load: async () => {
            if (world.libraryHangs === true) return new Promise(() => {});
            if (hit instanceof Error) throw hit;
            return { index: { find: () => hit }, degraded: world.degraded ?? [], counts: {} };
        }
    } as unknown as LibraryLoader;
}

const check = (subject: CrossCheckSubject, profile: CrossCheckProfile, world: World) =>
    buildCrossChecker(adaptersFor(world), libraryFor(world))(subject, profile);

const subject: CrossCheckSubject = {
    kind: 'movie',
    label: 'Alien (1979)',
    ids: { tmdb: 348 },
    acquisition: { service: 'radarr', id: '5' }
};

const request = (status: MediaRequest['status'], extra: Partial<MediaRequest> = {}): MediaRequest => ({
    service: 'seerr',
    id: 1,
    status,
    mediaType: 'movie',
    tmdbId: 348,
    requestedBy: 'Sam',
    ...extra
});

const status = (parts: Partial<CleanupStatus> = {}): CleanupStatus => ({
    service: 'reclaimerr',
    candidates: [],
    protections: [],
    removals: [],
    ...parts
});

const protection: CleanupProtection = { kind: 'movie', scope: 'movie', title: 'Alien', tmdbId: 348, permanent: true };
const removal: CleanupRemoval = {
    at: '2026-11-02T03:00:00Z',
    kind: 'movie',
    scope: 'movie',
    title: 'Alien',
    tmdbId: 348,
    operation: 'delete',
    rules: ['Unwatched']
};
const candidate: CleanupCandidate = {
    id: 'c1',
    kind: 'movie',
    scope: 'movie',
    title: 'Alien',
    tmdbId: 348,
    rules: ['Unwatched'],
    operation: 'delete',
    state: 'scheduled',
    eligibleAt: '2026-11-20T00:00:00Z'
};

const row = (extra: Partial<QueueItem> = {}): QueueItem => ({
    service: 'radarr',
    id: '1',
    title: 'Alien.1979.1080p',
    status: 'downloading',
    mediaId: '5',
    ...extra
});

const item = (extra: Partial<MergedItem> = {}): MergedItem => ({
    kind: 'movie',
    title: 'Alien',
    year: 1979,
    ids: { tmdb: 348 },
    presence: 'both',
    ...extra
});

afterEach(() => {
    vi.useRealTimers();
});

describe('cross-checks — delete', () => {
    it('asks Seerr for this title only when it has a TMDB id', async () => {
        const seerrAsked: string[] = [];
        const result = await check(subject, 'delete', { seerr: [request('approved')], seerrAsked });
        expect(seerrAsked).toEqual(['movie:348']);
        expect(result.warnings.join(' ')).toContain('Seerr still has a request');
    });

    it('asks for a series by its TMDB id as a tv title', async () => {
        const seerrAsked: string[] = [];
        await check({ kind: 'series', label: 'Breaking Bad', ids: { tmdb: 1396, tvdb: 81189 } }, 'delete', {
            seerr: [request('approved', { mediaType: 'tv', tmdbId: 1396 })],
            seerrAsked
        });
        expect(seerrAsked).toEqual(['tv:1396']);
    });

    it.each([
        ['an upstream error', new ServiceError('UpstreamError', 'seerr', 'Unable to retrieve movie.')],
        ['a not-found', new ServiceError('NotFound', 'seerr', 'no such title')]
    ])('still warns from the request list when the title lookup fails with %s', async (_n, titleError) => {
        const seerrAsked: string[] = [];
        const result = await check(subject, 'delete', { seerr: [request('approved')], seerrAsked, titleError });
        expect(seerrAsked).toEqual(['movie:348', 'list']);
        expect(result.warnings.join(' ')).toContain('Seerr still has a request');
    });

    it('does not hide another kind of failure behind the request list', async () => {
        const seerrAsked: string[] = [];
        const result = await check(subject, 'delete', {
            seerr: [request('approved')],
            seerrAsked,
            titleError: new ServiceError('Unreachable', 'seerr', 'connection refused')
        });
        expect(seerrAsked).toEqual(['movie:348']);
        expect(result.warnings).toEqual([]);
        expect(result.unchecked.join(' ')).toContain('seerr');
    });

    it('falls back to the request list for a series known only by TVDB', async () => {
        const seerrAsked: string[] = [];
        await check({ kind: 'series', label: 'Lost', ids: { tvdb: 73739 } }, 'delete', {
            seerr: [request('approved', { mediaType: 'tv', tvdbId: 73739 })],
            seerrAsked
        });
        expect(seerrAsked).toEqual(['list']);
    });

    it('warns that a Seerr request exists, and that delete_request removes it', async () => {
        const advice = await check(subject, 'delete', { seerr: [request('approved')] });
        expect(advice.warnings).toHaveLength(1);
        expect(advice.warnings[0]).toContain('delete_request');
        expect(advice.warnings[0]).toContain('does not remove it');
    });

    it('stays quiet when nobody requested the title', async () => {
        const advice = await check(subject, 'delete', { seerr: [request('approved', { tmdbId: 999 })] });
        expect(advice).toEqual({ warnings: [], unchecked: [] });
    });

    it('never names who made the request', async () => {
        const advice = await check(subject, 'delete', { seerr: [{ ...request('approved'), requestedBy: 'Sam' }] });
        expect(advice.warnings.join(' ')).not.toContain('Sam');
    });

    it('warns when Reclaimerr protects the title', async () => {
        const advice = await check(subject, 'delete', { reclaimerr: status({ protections: [protection] }) });
        expect(advice.warnings).toEqual(['reclaimerr has an active protection on Alien (1979).']);
    });

    it('warns that a row is still downloading', async () => {
        const advice = await check(subject, 'delete', { queues: { radarr: [row()] } });
        expect(advice.warnings).toEqual(['Alien (1979) is still downloading in radarr.']);
    });

    // Radarr attaches this to a magnet still fetching its metadata (`QBittorrent`).
    it('counts a row still on its way as downloading, with the message it carries', async () => {
        const fetching = row({ status: 'queued', errorMessage: 'qBittorrent is downloading metadata' });
        expect((await check(subject, 'delete', { queues: { radarr: [fetching] } })).warnings).toEqual(['Alien (1979) is still downloading in radarr.']);
    });

    it('warns that a seeding row may not free the disk space if hardlinked', async () => {
        const advice = await check(subject, 'delete', {
            queues: { qbittorrent: [{ service: 'qbittorrent', id: 'abc', title: 'Alien 1979 1080p', status: 'seeding' }] }
        });
        expect(advice.warnings).toHaveLength(1);
        expect(advice.warnings[0]).toContain('still seeding in qbittorrent');
        expect(advice.warnings[0]).toContain('may not free the disk space if');
        expect(advice.warnings[0]).toContain('hardlinked');
    });

    // delete_media without delete_files leaves the files where they are, so nothing is freed or not freed.
    it('leaves out the seeding warning when the files stay, and keeps the rest', async () => {
        const staying: CrossCheckSubject = { ...subject, filesStay: true };
        const seeding = { service: 'qbittorrent', id: 'abc', title: 'Alien 1979 1080p', status: 'seeding' };

        expect((await check(staying, 'delete', { queues: { qbittorrent: [seeding] } })).warnings).toEqual([]);
        expect((await check(staying, 'delete', { queues: { radarr: [row()] } })).warnings).toEqual([
            'Alien (1979) is still downloading in radarr.'
        ]);
    });

    it('ignores a queue row that belongs to another title', async () => {
        const advice = await check(subject, 'delete', { queues: { radarr: [row({ mediaId: '77', title: 'Aliens.1986.1080p' })] } });
        expect(advice.warnings).toEqual([]);
    });

    it('warns when the default user has not watched it', async () => {
        const advice = await check(subject, 'delete', {
            library: item({ playback: { user: 'default', watched: false } })
        });
        expect(advice.warnings).toEqual(['Alien (1979) has not been watched yet by the default user.']);
    });

    it('does not say a season delete is unwatched because the series as a whole is', async () => {
        const series: CrossCheckSubject = { kind: 'series', label: 'Severance', ids: { tvdb: 371980 }, seasons: [1] };
        const advice = await check(series, 'delete', {
            library: item({
                kind: 'series',
                ids: { tvdb: 371980 },
                playback: { user: 'default', watched: false },
                seasons: [{ season: 1, complete: true }, { season: 2, complete: false }]
            })
        });
        expect(advice.warnings).toEqual([]);
    });

    it('gives no watch warning for named episodes, which are part of a title with no season answer', async () => {
        const series: CrossCheckSubject = { kind: 'series', label: 'Severance', ids: { tvdb: 371980 }, seasons: [] };
        const advice = await check(series, 'delete', {
            library: item({ kind: 'series', ids: { tvdb: 371980 }, playback: { user: 'default', watched: false } })
        });
        expect(advice.warnings).toEqual([]);
    });

    it('says what it could not check when a subject has no ids', async () => {
        const nameless: CrossCheckSubject = { kind: 'movie', label: 'Alien.1979-GROUP', ids: {} };
        const advice = await check(nameless, 'acquire', { seerr: [], reclaimerr: status(), library: null });
        expect(advice.warnings).toEqual([]);
        expect(advice.unchecked).toEqual(['reclaimerr (no TMDB id)', 'seerr (no TMDB id)']);
    });

    it('names several unwatched seasons readably', async () => {
        const series: CrossCheckSubject = { kind: 'series', label: 'Severance', ids: { tvdb: 371980 }, seasons: [1, 2] };
        const advice = await check(series, 'delete', {
            library: item({ kind: 'series', ids: { tvdb: 371980 }, seasons: [{ season: 1, complete: false }, { season: 2, complete: false }] })
        });
        expect(advice.warnings).toEqual(['Seasons 1, 2 of Severance have not been fully watched yet.']);
    });

    it('does not warn when watch state is absent or watched', async () => {
        expect((await check(subject, 'delete', { library: item({ playback: { user: 'default' } }) })).warnings).toEqual([]);
        expect((await check(subject, 'delete', { library: item({ playback: { user: 'default', watched: true } }) })).warnings).toEqual([]);
        expect((await check(subject, 'delete', { library: null })).warnings).toEqual([]);
    });

    it('warns about a deleted season that is not fully watched, and only that one', async () => {
        const series: CrossCheckSubject = { kind: 'series', label: 'Severance', ids: { tvdb: 371980 }, seasons: [1, 2, 3] };
        const advice = await check(series, 'delete', {
            library: item({
                kind: 'series',
                ids: { tvdb: 371980 },
                seasons: [
                    { season: 1, complete: true },
                    { season: 2, complete: false },
                    { season: 3 },
                    { season: 4, complete: false }
                ]
            })
        });
        expect(advice.warnings).toEqual(['Season 2 of Severance has not been fully watched yet.']);
    });

    // The series flag is "all watched", so false means "not all", and a show you are current on goes false when a new episode lands.
    describe('a series nobody has watched in full', () => {
        const show: CrossCheckSubject = { kind: 'series', label: 'Severance', ids: { tvdb: 371980 } };
        const partly = (seasons?: SeasonSummary[]) =>
            item({ kind: 'series', ids: { tvdb: 371980 }, playback: { user: 'default', watched: false }, ...(seasons === undefined ? {} : { seasons }) });

        it('keeps the not-watched sentence when no season has an episode watched', async () => {
            const advice = await check(show, 'delete', { library: partly([{ season: 1, watched: 0, total: 10 }, { season: 2, watched: 0, total: 10 }]) });
            expect(advice.warnings).toEqual(['Severance has not been watched yet by the default user.']);
        });

        it('says it is partly watched, with the count, when a season has watched episodes', async () => {
            const advice = await check(show, 'delete', {
                library: partly([{ season: 1, watched: 10, total: 10 }, { season: 2, watched: 9, total: 10 }])
            });
            expect(advice.warnings).toEqual(['Severance is only partly watched by the default user: 19 episodes watched so far.']);
        });

        it('counts one episode in the singular', async () => {
            const advice = await check(show, 'delete', { library: partly([{ season: 1, watched: 1, total: 8 }]) });
            expect(advice.warnings).toEqual(['Severance is only partly watched by the default user: 1 episode watched so far.']);
        });

        it('skips a season the server holds nothing of rather than counting it as no evidence', async () => {
            const advice = await check(show, 'delete', { library: partly([{ season: 1, total: 8 }, { season: 2, watched: 0, total: 8 }]) });
            expect(advice.warnings).toEqual(['Severance has not been watched yet by the default user.']);
            const some = await check(show, 'delete', { library: partly([{ season: 1, total: 8 }, { season: 2, watched: 3, total: 8 }]) });
            expect(some.warnings).toEqual(['Severance is only partly watched by the default user: 3 episodes watched so far.']);
        });

        it('says only that it is not fully watched when no season could be counted', async () => {
            const expected = ['Severance has not been fully watched yet by the default user.'];
            expect((await check(show, 'delete', { library: partly(undefined) })).warnings).toEqual(expected);
            expect((await check(show, 'delete', { library: partly([]) })).warnings).toEqual(expected);
            expect((await check(show, 'delete', { library: partly([{ season: 1, total: 8 }]) })).warnings).toEqual(expected);
        });

        it('leaves a film with the not-watched sentence', async () => {
            const advice = await check(subject, 'delete', { library: item({ playback: { user: 'default', watched: false } }) });
            expect(advice.warnings).toEqual(['Alien (1979) has not been watched yet by the default user.']);
        });
    });

    // A database-only delete keeps the file playable, so whether it was watched costs nothing.
    it('leaves out the watch warning when the files stay', async () => {
        const staying: CrossCheckSubject = { ...subject, filesStay: true };
        const library = item({ playback: { user: 'default', watched: false } });
        expect((await check(staying, 'delete', { library })).warnings).toEqual([]);
        expect((await check(subject, 'delete', { library })).warnings).toHaveLength(1);
    });

    it('lists only the degraded sources that bear on the kind of title', async () => {
        const degraded = ['jellyfin', 'jellyfin:music', 'jellyfin:seasons', 'lidarr', 'sonarr', 'sonarr/4k', 'radarr/4k', 'whisparr'];
        const film = await check(subject, 'delete', { library: item(), degraded });
        expect(film.unchecked).toEqual(['jellyfin', 'radarr/4k']);

        const show: CrossCheckSubject = { kind: 'series', label: 'Severance', ids: { tvdb: 371980 } };
        const series = await check(show, 'delete', { library: item({ kind: 'series', ids: { tvdb: 371980 } }), degraded });
        expect(series.unchecked).toEqual(['jellyfin', 'sonarr', 'sonarr/4k', 'whisparr']);
    });

    it('a Grimmory outage is not an unchecked gap for a film delete', async () => {
        // A real loader, so the snapshot's own `degraded` carries `grimmory`.
        const film = { kind: 'movie' as const, title: 'Alien', year: 1979, ids: { tmdb: 348 }, acquisition: { service: 'radarr', id: '5', monitored: true, hasFile: true } };
        const run = async (grimmory: () => Promise<unknown[]>) => {
            const adapters = [stub('radarr', { listLibrary: async () => [film] }), stub('grimmory', { listLibrary: grimmory })];
            const loader = new LibraryLoader(adapters, undefined);
            return { degraded: (await loader.load()).degraded, advice: await buildCrossChecker(adapters, loader)(subject, 'delete') };
        };
        const healthy = await run(async () => []);
        const down = await run(async () => {
            throw new Error('grimmory down');
        });

        expect(down.degraded).toContain('grimmory');
        expect(down.advice.unchecked).not.toContain('grimmory');
        // Everything else the check says is what it says with Grimmory up.
        expect(down.advice).toEqual(healthy.advice);
    });

    it('reports the library as unchecked when the watch state could not be read', async () => {
        const advice = await check(subject, 'delete', { library: new Error('down') });
        expect(advice).toEqual({ warnings: [], unchecked: ['library'] });
    });
});

describe('cross-checks — acquire', () => {
    it('warns that Reclaimerr removed the title, and to protect it first', async () => {
        const advice = await check(subject, 'acquire', { reclaimerr: status({ removals: [removal] }) });
        expect(advice.warnings).toHaveLength(1);
        expect(advice.warnings[0]).toContain('reclaimerr deleted it on 2026-11-02 under rule Unwatched.');
        expect(advice.warnings[0]).toContain('Protect Alien (1979) in reclaimerr first');
    });

    it('warns that a candidate is scheduled', async () => {
        const advice = await check(subject, 'acquire', { reclaimerr: status({ candidates: [candidate] }) });
        expect(advice.warnings).toHaveLength(1);
        expect(advice.warnings[0]).toContain('reclaimerr is set to delete it on 2026-11-20 under rule Unwatched.');
        expect(advice.warnings[0]).toContain('Protect');
    });

    it('stays quiet about a season removal, which leaves the title on disk', async () => {
        const advice = await check(subject, 'acquire', {
            reclaimerr: status({ removals: [{ ...removal, scope: 'season', seasonNumber: 1 }] })
        });
        expect(advice.warnings).toEqual([]);
    });

    it('warns when the request is pending or declined, not when it is approved', async () => {
        expect((await check(subject, 'acquire', { seerr: [request('pending')] })).warnings).toEqual([
            'The Seerr request for Alien (1979) is still waiting for approval.'
        ]);
        expect((await check(subject, 'acquire', { seerr: [request('declined')] })).warnings).toEqual([
            'The Seerr request for Alien (1979) was declined.'
        ]);
        expect((await check(subject, 'acquire', { seerr: [request('approved')] })).warnings).toEqual([]);
    });

    it('warns when a row is already downloading it', async () => {
        const advice = await check(subject, 'acquire', { queues: { radarr: [row()] } });
        expect(advice.warnings).toEqual(['Alien (1979) is already downloading in radarr.']);
    });

    it('does not warn about a seeding row', async () => {
        const advice = await check(subject, 'acquire', { queues: { radarr: [row({ status: 'seeding' })] } });
        expect(advice.warnings).toEqual([]);
    });
});

describe('cross-checks — ids', () => {
    const sonarr: CrossCheckSubject = { kind: 'series', label: 'Severance', ids: { tvdb: 371980 } };

    it('takes the TMDB id a Sonarr record lacks from the library', async () => {
        const advice = await check(sonarr, 'acquire', {
            reclaimerr: status({ removals: [{ ...removal, kind: 'series', scope: 'series' }] }),
            library: item({ kind: 'series', ids: { tvdb: 371980, tmdb: 95396 } })
        });
        expect(advice.unchecked).toEqual([]);
        expect(advice.warnings).toHaveLength(1);
    });

    it('says Reclaimerr could not be asked when the title has no TMDB id', async () => {
        const advice = await check(sonarr, 'acquire', { reclaimerr: status(), library: null });
        expect(advice).toEqual({ warnings: [], unchecked: ['reclaimerr (no TMDB id)'] });
    });

    it('says Seerr could not be asked when the title has neither TMDB nor TVDB', async () => {
        const bare: CrossCheckSubject = { kind: 'movie', label: 'Alien (1979)', ids: { imdb: 'tt0078748' } };
        const advice = await check(bare, 'acquire', { seerr: [request('pending')], library: null });
        expect(advice).toEqual({ warnings: [], unchecked: ['seerr (no TMDB id)'] });
    });

    it('matches a series request on TVDB when there is no TMDB id', async () => {
        const advice = await check(sonarr, 'delete', {
            seerr: [{ service: 'seerr', id: 2, status: 'approved', mediaType: 'tv', tvdbId: 371980, requestedBy: 'Sam' }]
        });
        expect(advice.warnings).toHaveLength(1);
    });

    it('does not read the library to fill in ids it does not need', async () => {
        const load = vi.fn();
        const checker = buildCrossChecker(adaptersFor({ seerr: [request('pending')] }), { load } as unknown as LibraryLoader);
        await checker(subject, 'acquire');
        expect(load).not.toHaveBeenCalled();
    });

    it('carries on with the subject’s own ids when the library cannot be read', async () => {
        const advice = await check(sonarr, 'acquire', {
            seerr: [{ service: 'seerr', id: 2, status: 'pending', mediaType: 'tv', tvdbId: 371980, requestedBy: 'Sam' }],
            reclaimerr: status(),
            library: new Error('down')
        });
        expect(advice.warnings).toEqual(['The Seerr request for Severance is still waiting for approval.']);
        expect(advice.unchecked).toEqual(['library', 'reclaimerr (no TMDB id)']);
    });

    it('does not take a request for a film as a request for a series sharing its TMDB id', async () => {
        const series: CrossCheckSubject = { kind: 'series', label: 'Severance', ids: { tmdb: 348 } };
        const advice = await check(series, 'acquire', { seerr: [request('declined')] });
        expect(advice).toEqual({ warnings: [], unchecked: [] });
    });

    it('sees a pending request behind an approved one for the same series', async () => {
        const advice = await check(subject, 'acquire', {
            seerr: [request('approved'), request('pending', { id: 2 })]
        });
        expect(advice.warnings).toEqual(['The Seerr request for Alien (1979) is still waiting for approval.']);
    });

    it('matches queue rows by title from a fenced, year-suffixed label with no acquisition', async () => {
        const added: CrossCheckSubject = {
            kind: 'movie',
            label: '<<untrusted:abc123>>Alien<</>> (1979)',
            ids: { tmdb: 348 }
        };
        const advice = await check(added, 'acquire', {
            queues: { qbittorrent: [{ service: 'qbittorrent', id: 'a', title: 'Alien 1080p BluRay', status: 'downloading' }] }
        });
        expect(advice.warnings).toHaveLength(1);
        expect(advice.warnings[0]).toContain('already downloading in qbittorrent');
    });

    it('asks Reclaimerr with the TMDB id the library supplied', async () => {
        const asked = vi.fn();
        await check(sonarr, 'acquire', {
            reclaimerr: status(),
            library: item({ kind: 'series', ids: { tvdb: 371980, tmdb: 95396 } }),
            asked
        });
        expect(asked).toHaveBeenCalledWith('series', 95396);
    });

    it('reports a media server that is down while the library still loads', async () => {
        const advice = await check(subject, 'delete', {
            library: item(),
            degraded: ['jellyfin', 'jellyfin:seasons']
        });
        expect(advice).toEqual({ warnings: [], unchecked: ['jellyfin'] });
    });
});

describe('cross-checks — failure and budget', () => {
    it('reports a failed read as unchecked rather than as no warning', async () => {
        const advice = await check(subject, 'delete', { seerr: new Error('down') });
        expect(advice).toEqual({ warnings: [], unchecked: ['seerr'] });
    });

    it('counts the rows another queue returned when one instance is down', async () => {
        const advice = await check(subject, 'delete', { queues: { radarr: [row()], sabnzbd: new Error('down') } });
        expect(advice.warnings).toEqual(['Alien (1979) is still downloading in radarr.']);
        expect(advice.unchecked).toEqual(['sabnzbd']);
    });

    it('leaves Lidarr’s artist queue out', async () => {
        const advice = await check(subject, 'delete', { queues: { lidarr: new Error('down') } });
        expect(advice).toEqual({ warnings: [], unchecked: [] });
    });

    it('gives up on a slow service at the budget and keeps the others', async () => {
        vi.useFakeTimers();
        const pending = check(subject, 'delete', {
            seerr: new Promise<MediaRequest[]>(() => {}),
            reclaimerr: status({ protections: [protection] })
        });
        await vi.advanceTimersByTimeAsync(CROSS_CHECK_BUDGET_MS);
        const advice = await pending;
        expect(advice.unchecked).toEqual(['seerr']);
        expect(advice.warnings).toHaveLength(1);
    });

    it('keeps the other services when the library is the slow one', async () => {
        vi.useFakeTimers();
        const pending = check(subject, 'delete', {
            reclaimerr: status({ protections: [protection] }),
            queues: { radarr: [row()] },
            libraryHangs: true
        });
        await vi.advanceTimersByTimeAsync(CROSS_CHECK_BUDGET_MS);
        const advice = await pending;
        expect(advice.unchecked).toEqual(['library']);
        expect(advice.warnings).toHaveLength(2);
    });

    it('leaves no timer running once the checks finish', async () => {
        vi.useFakeTimers();
        await check(subject, 'delete', { seerr: [request('approved')] });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('says nothing about a service that is not configured', async () => {
        expect(await check(subject, 'delete', {})).toEqual({ warnings: [], unchecked: [] });
        expect(await check(subject, 'acquire', {})).toEqual({ warnings: [], unchecked: [] });
    });
});
