import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KeyedServiceConfig } from '../src/config/schema.ts';
import { ServiceError } from '../src/core/errors.ts';
import { fenceText } from '../src/core/fence.ts';
import { IdentityResolver } from '../src/core/identity.ts';
import type { IndexInput } from '../src/core/resolver.ts';
import { buildChain as chain, type Diagnosis, type Evidence } from '../src/tools/diagnose/chain.ts';
import { collectEvidence, DIAGNOSE_BUDGET_MS, findRequest } from '../src/tools/diagnose/evidence.ts';
import { buildDiagnose, type DiagnoseDeps } from '../src/tools/diagnose/index.ts';
import { LibraryLoader } from '../src/tools/library.ts';
import { GrimmoryAdapter } from '../src/services/grimmory.ts';
import { LidarrAdapter } from '../src/services/lidarr.ts';
import type { MediaRequest, ServiceAdapter, UserDirectoryCapable } from '../src/services/types.ts';

/** These tests diagnose by title, the form that takes a query. */
const buildChain = (query: string, ev: Evidence): Diagnosis => chain(query, ev, true);

const stub = (id: string, extra: Record<string, unknown>): ServiceAdapter =>
    ({
        id,
        // Every real adapter sets `type` alongside `id` — `radarr` for both
        // `radarr` and `radarr/4k` — and instance resolution matches on it.
        // A double without one is not a double of anything this code runs
        // against.
        type: id.split('/')[0],
        testConnection: async () => ({ ok: true, service: id, latency_ms: 1 }),
        getVersion: async () => '1.0.0',
        ...extra
    }) as unknown as ServiceAdapter;

const lidarrConfig: KeyedServiceConfig = {
    url: 'http://192.0.2.10:8686',
    api_key: 'test-key',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
};

const lidarrFixture = (name: string): unknown =>
    JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/lidarr', `${name}.json`), 'utf8'));

/**
 * The real adapter over the recorded Lidarr responses: one artist, Daft Punk,
 * monitored, with no track on disk, four monitored albums and an empty queue.
 * `albums` stands in for the album list (`null`: the album read fails); `seen`
 * collects every path asked for; `trackFiles` puts tracks on disk.
 */
const lidarr = (albums: unknown = lidarrFixture('album'), seen: string[] = [], trackFiles = 0): LidarrAdapter => {
    const withFiles = (artist: Record<string, unknown>) => ({
        ...artist,
        statistics: { ...(artist.statistics as object), trackFileCount: trackFiles }
    });
    const routes: Record<string, unknown> = {
        '/api/v1/artist': (lidarrFixture('artist') as Record<string, unknown>[]).map(withFiles),
        '/api/v1/artist/1': withFiles(lidarrFixture('artist-detail') as Record<string, unknown>),
        ...(albums === null ? {} : { '/api/v1/album': albums }),
        '/api/v1/queue': { ...(lidarrFixture('queue') as object), records: [], totalRecords: 0 }
    };
    const impl = (async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        seen.push(url.pathname);
        if (!(url.pathname in routes)) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
        return new Response(JSON.stringify(routes[url.pathname]), { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return new LidarrAdapter(lidarrConfig, impl);
};
const FILM: IndexInput = {
    kind: 'movie',
    title: '<<untrusted:radarr.title>>Some Film<</>>',
    year: 2026,
    ids: { tmdb: 550 },
    acquisition: { service: 'radarr', monitored: true, hasFile: false }
};

const deps = (over: Partial<Record<string, unknown>> = {}): DiagnoseDeps => {
    const adapters = [
        stub('radarr', {
            listLibrary: async () => [FILM],
            getQueue: async () => over.queue ?? []
        }),
        stub('prowlarr', { getIndexers: async () => [], getRecentRejections: async () => over.rejections ?? [] }),
        stub('jellyfin', { getScanState: async () => ({ service: 'jellyfin', lastCompleted: '2026-08-05T02:00:00Z' }) }),
        stub('seerr', { getRequests: async () => over.requests ?? [] })
    ];
    return { adapters, library: new LibraryLoader(adapters, undefined) };
};

describe('diagnose', () => {
    it('resolves a title and returns the chain', async () => {
        const d = await buildDiagnose(deps(), { query: 'some film' });
        expect(d.resolved?.ids).toEqual({ tmdb: 550 });
        expect(d.steps).toHaveLength(9);
    });

    it('reports the missing file when nothing else explains it', async () => {
        const d = await buildDiagnose(deps(), { query: 'some film' });
        expect(d.verdict).toMatchObject({ stage: 'file', certain: true });
    });

    it('finds the item in the download queue and blames that instead', async () => {
        const d = await buildDiagnose(
            deps({ queue: [{ service: 'radarr', id: '1', title: 'Some.Film.2026.1080p', status: 'downloading' }] }),
            { query: 'some film' }
        );
        expect(d.verdict.stage).toBe('queue');
    });

    it('matches a Seerr request by tmdb id rather than by title', async () => {
        // Seerr's request payload carries no title at all, so a title match
        // here would find nothing on real data.
        const d = await buildDiagnose(
            deps({ requests: [{ service: 'seerr', id: 1, status: 'pending', mediaType: 'movie', tmdbId: 550, requestedBy: 'Someone' }] }),
            { query: 'some film' }
        );
        expect(d.verdict.stage).toBe('request');
    });

    it('does not report who requested it', async () => {
        // §9: the request status answers the question; naming the requester
        // exposes another household member's activity to whoever asked.
        const d = await buildDiagnose(
            deps({ requests: [{ service: 'seerr', id: 1, status: 'pending', mediaType: 'movie', tmdbId: 550, requestedBy: 'Someone Else' }] }),
            { query: 'some film' }
        );
        expect(JSON.stringify(d)).not.toContain('Someone Else');
    });

    describe('counting the enabled indexers', () => {
        const indexer = (id: number, enabled: boolean, disabledUntil?: string) => ({
            service: 'prowlarr',
            id,
            name: `i${id}`,
            enabled,
            protocol: 'torrent',
            priority: 25,
            ...(disabledUntil === undefined ? {} : { disabledUntil })
        });
        const withProwlarr = (query: string, counts: { reads: number }, fails = false, disabledUntil?: string): DiagnoseDeps => {
            const adapters = [
                stub('radarr', { listLibrary: async () => [FILM], getQueue: async () => [] }),
                stub('prowlarr', {
                    getIndexers: async () => {
                        counts.reads += 1;
                        if (fails) throw new Error('down');
                        return [indexer(1, true), indexer(2, true, disabledUntil), indexer(3, true), indexer(4, false)];
                    },
                    getRecentRejections: async () => [{ service: 'prowlarr', indexer: 'i1', indexerId: 1, at: '2026-08-05T02:00:00Z', reason: 'HTTP 429', query }]
                })
            ];
            return { adapters, library: new LibraryLoader(adapters, undefined) };
        };

        it('reads them when a failure mentions the item, and weighs the failure against them', async () => {
            const counts = { reads: 0 };
            const d = await buildDiagnose(withProwlarr('Some Film', counts), { query: 'some film' });
            expect(counts.reads).toBe(1);
            expect(d.steps.find(s => s.stage === 'indexers')).toMatchObject({ status: 'warning', detail: expect.stringContaining('from 1 of 3 enabled indexer(s)') });
            expect(d.verdict.stage).toBe('file');
        });

        it('counts one Prowlarr has disabled for now as out, and one whose disable ran out as back', async () => {
            const later = new Date(Date.now() + 3_600_000).toISOString();
            const d = await buildDiagnose(withProwlarr('Some Film', { reads: 0 }, false, later), { query: 'some film' });
            expect(d.steps.find(s => s.stage === 'indexers')).toMatchObject({ status: 'blocked', detail: expect.stringContaining('from 1 of 3 enabled indexer(s), 1 more disabled by Prowlarr') });
            const past = await buildDiagnose(withProwlarr('Some Film', { reads: 0 }, false, '2020-01-01T00:00:00Z'), { query: 'some film' });
            expect(past.steps.find(s => s.stage === 'indexers')).toMatchObject({ status: 'warning' });
        });

        it('does not read them when no failure mentions the item', async () => {
            const counts = { reads: 0 };
            await buildDiagnose(withProwlarr('Another Title', counts), { query: 'some film' });
            expect(counts.reads).toBe(0);
        });

        it('keeps the failure the verdict when they cannot be read, without costing certainty', async () => {
            const d = await buildDiagnose(withProwlarr('Some Film', { reads: 0 }, true), { query: 'some film' });
            expect(d.verdict).toMatchObject({ stage: 'indexers', certain: true });
            expect(d.degraded).toContain('prowlarr:indexers');
        });
    });

    it('names the rejection get_indexers lists first when two Prowlarrs have one from the same moment', async () => {
        // Listed against id order, the order adapters normally come in, so the tie
        // is settled by the sort and not by the list.
        const rejection = (service: string, indexer: string) => ({ service, indexer, at: '2026-08-05T02:00:00Z', reason: 'HTTP 429', query: 'Some Film' });
        const adapters = [
            stub('radarr', { listLibrary: async () => [FILM], getQueue: async () => [] }),
            stub('prowlarr/public', { getIndexers: async () => [], getRecentRejections: async () => [rejection('prowlarr/public', 'i1')] }),
            stub('prowlarr/private', { getIndexers: async () => [], getRecentRejections: async () => [rejection('prowlarr/private', 'i2')] })
        ];
        const d = await buildDiagnose({ adapters, library: new LibraryLoader(adapters, undefined) }, { query: 'some film' });
        expect(d.steps.find(s => s.stage === 'indexers')?.detail).toContain('most recently i2 on prowlarr/private: HTTP 429.');
    });

    it('degrades a failing service into unknown rather than failing the call', async () => {
        const adapters = [
            stub('radarr', { listLibrary: async () => [FILM], getQueue: async () => [] }),
            stub('prowlarr', {
                getIndexers: async () => [],
                getRecentRejections: async () => {
                    throw new ServiceError('Unreachable', 'prowlarr', 'connection refused');
                }
            })
        ];
        const d = await buildDiagnose(
            { adapters, library: new LibraryLoader(adapters, undefined) },
            { query: 'some film' }
        );

        expect(d.degraded).toContain('prowlarr');
        expect(d.steps.find(s => s.stage === 'indexers')?.status).toBe('unknown');
    });

    it('is uncertain when the unreachable service sits before the verdict', async () => {
        const adapters = [
            stub('radarr', { listLibrary: async () => [FILM] }),
            stub('prowlarr', {
                getIndexers: async () => [],
                getRecentRejections: async () => {
                    throw new Error('down');
                }
            })
        ];
        const d = await buildDiagnose(
            { adapters, library: new LibraryLoader(adapters, undefined) },
            { query: 'some film' }
        );
        expect(d.verdict.certain).toBe(false);
    });

    it('accepts an explicit service and id', async () => {
        const withDetails = deps();
        (withDetails.adapters[0] as unknown as Record<string, unknown>).getMediaDetails = async () => ({
            service: 'radarr',
            kind: 'movie',
            id: '1',
            title: 'Some Film',
            ids: { tmdb: 550 }
        });

        const d = await buildDiagnose(withDetails, { service: 'radarr', id: '1' });
        expect(d.resolved?.ids).toEqual({ tmdb: 550 });
    });

    // Synthesised from the id alone (not in the index), but Radarr said
    // `movie`, so the kind is not a guess and only Radarr counts.
    it('does not mark the kind guessed for an *arr id the index lacks', async () => {
        const adapters = [
            stub('radarr', {
                listLibrary: async () => [],
                getMediaDetails: async () => ({ service: 'radarr', kind: 'movie', id: '1', title: 'Some Film', ids: { tmdb: 550 } })
            })
        ];
        const evidence = await collectEvidence({ adapters, library: new LibraryLoader(adapters, undefined) }, { service: 'radarr', id: '1' });
        expect(evidence.item?.kind).toBe('movie');
        expect(evidence.item?.acquisition?.service).toBe('radarr');
        expect(evidence.itemKindGuessed).toBeUndefined();
    });

    it('accepts an explicit id against a named instance', async () => {
        // A named Radarr has `id: "radarr/4k"`, so the open-coded
        // `find(a => a.id === service)` matched nothing and diagnose answered
        // "radarr is not configured" about a Radarr that plainly is. This is
        // the lookup resolveInstance was written to replace, and diagnose is
        // the one caller that was never converted.
        const adapters = [
            stub('radarr/4k', {
                type: 'radarr',
                instance: '4k',
                listLibrary: async () => [FILM],
                getMediaDetails: async () => ({
                    service: 'radarr/4k',
                    kind: 'movie',
                    id: '1',
                    title: 'Some Film',
                    ids: { tmdb: 550 }
                })
            })
        ];

        const d = await buildDiagnose(
            { adapters, library: new LibraryLoader(adapters, undefined) },
            { service: 'radarr', id: '1' }
        );
        expect(d.resolved?.ids).toEqual({ tmdb: 550 });
    });

    it('refuses rather than guessing when two instances are configured and none is named', async () => {
        const adapters = [
            stub('radarr/hd', { type: 'radarr', instance: 'hd', listLibrary: async () => [], getMediaDetails: async () => ({}) }),
            stub('radarr/4k', { type: 'radarr', instance: '4k', listLibrary: async () => [], getMediaDetails: async () => ({}) })
        ];

        await expect(
            buildDiagnose({ adapters, library: new LibraryLoader(adapters, undefined) }, { service: 'radarr', id: '1' })
        ).rejects.toThrow(/does not say which/);
    });

    it('diagnoses an explicit id the index does not contain', async () => {
        // The service holding it may be the one that failed to load. Reporting
        // the item unknown when the caller just handed us its id would be a
        // worse answer than diagnosing the half we have.
        const orphan = deps();
        (orphan.adapters[0] as unknown as Record<string, unknown>).getMediaDetails = async () => ({
            service: 'radarr',
            kind: 'movie',
            id: '99',
            title: 'Another Film',
            monitored: true,
            hasFile: false,
            ids: { tmdb: 999 }
        });

        const d = await buildDiagnose(orphan, { service: 'radarr', id: '99' });
        expect(d.verdict.stage).not.toBe('resolve');
        expect(d.resolved?.ids).toEqual({ tmdb: 999 });
    });

    it('diagnoses a Lidarr artist by id', async () => {
        // The artist row once failed `isFilmOrSeries` and fell through to a
        // synthesised `kind: 'movie'` item with Lidarr acquisition, checked
        // against Radarr's queue and indexers. It is its own kind now.
        const adapters = [lidarr()];
        const d = await buildDiagnose({ adapters, library: new LibraryLoader(adapters, undefined) }, { service: 'lidarr', id: '1' });

        expect(d.resolved).toMatchObject({ kind: 'artist', ids: { mbid: '056e4f3e-d505-4dad-8ec1-d04f521cbb56' } });
        expect(d.resolved?.title).toContain('Daft Punk');
        // no film stage is claimed: nothing about Seerr or Bazarr was looked at
        expect(d.steps.find(s => s.stage === 'request')?.status).toBe('skipped');
        expect(d.steps.find(s => s.stage === 'subtitles')?.status).toBe('skipped');
        expect(d.verdict).toMatchObject({ stage: 'file', certain: true });
    });

    // A Lidarr search grabs only releases of a monitored album, so before it is
    // suggested for an artist with no tracks, the albums are read.
    it('reads the albums of an artist with no tracks, and suggests trigger_search while one is monitored', async () => {
        const seen: string[] = [];
        const adapters = [lidarr(undefined, seen)];
        const d = await buildDiagnose({ adapters, library: new LibraryLoader(adapters, undefined) }, { service: 'lidarr', id: '1' });

        expect(seen).toContain('/api/v1/album');
        expect(d.verdict.next_steps?.map(s => s.tool)).toEqual(['trigger_search']);
        expect(d.degraded).not.toContain('lidarr:albums');
    });

    it('suggests monitoring an album first when none of the artist\'s albums is', async () => {
        const none = (lidarrFixture('album') as Record<string, unknown>[]).map(a => ({ ...a, monitored: false }));
        const adapters = [lidarr(none)];
        const d = await buildDiagnose({ adapters, library: new LibraryLoader(adapters, undefined) }, { service: 'lidarr', id: '1' });

        expect(d.verdict).toMatchObject({ stage: 'file', certain: true });
        expect(d.verdict.remedy).toMatch(/^None of its 4 albums is monitored in lidarr, and a search grabs only releases of a monitored album, so it would grab nothing\./);
        expect(d.verdict.next_steps).toEqual([
            {
                tool: 'get_media_details',
                arguments: { service: 'lidarr', id: '1', detail: 'full' },
                why: 'Lists its albums and their ids, to choose which to monitor with set_monitoring at `level: "album"`.'
            }
        ]);
    });

    it('still suggests trigger_search when the album read fails, without costing the verdict its certainty', async () => {
        const adapters = [lidarr(null)];
        const d = await buildDiagnose({ adapters, library: new LibraryLoader(adapters, undefined) }, { service: 'lidarr', id: '1' });

        expect(d.verdict).toMatchObject({ stage: 'file', certain: true });
        expect(d.verdict.next_steps?.map(s => s.tool)).toEqual(['trigger_search']);
        expect(d.degraded).toContain('lidarr:albums');
    });

    it('keeps a named Lidarr\'s failed album read off the queue, and names the instance in the step', async () => {
        const fixtures = (name: string) => lidarrFixture(name);
        const routes: Record<string, unknown> = {
            '/api/v1/artist': fixtures('artist'),
            '/api/v1/artist/1': fixtures('artist-detail'),
            '/api/v1/queue': { ...(fixtures('queue') as object), records: [], totalRecords: 0 }
        };
        const impl = (async (input: string | URL | Request) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (!(url.pathname in routes)) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
            return new Response(JSON.stringify(routes[url.pathname]), { headers: { 'content-type': 'application/json' } });
        }) as unknown as typeof fetch;
        const named = new LidarrAdapter({ ...lidarrConfig, name: 'one' } as never, impl);
        const adapters = [named];
        const d = await buildDiagnose({ adapters, library: new LibraryLoader(adapters, undefined) }, { service: 'lidarr', instance: 'one', id: '1' });

        expect(d.degraded).toContain('lidarr/one:albums');
        expect(d.steps.find(s => s.stage === 'queue')?.status).toBe('skipped');
        expect(d.verdict).toMatchObject({ stage: 'file', certain: true });
        expect(d.verdict.next_steps).toMatchObject([{ tool: 'trigger_search', arguments: { service: 'lidarr', instance: 'one', id: '1' } }]);
    });

    it('does not read the albums of an artist with tracks', async () => {
        const seen: string[] = [];
        const adapters = [lidarr(undefined, seen, 3)];
        const d = await buildDiagnose({ adapters, library: new LibraryLoader(adapters, undefined) }, { service: 'lidarr', id: '1' });

        expect(d.steps.find(s => s.stage === 'file')?.status).toBe('ok');
        expect(seen).not.toContain('/api/v1/album');
    });

    it('keeps trigger_search when the album list is cut off at 500, none of the first 500 monitored', async () => {
        const many = Array.from({ length: 501 }, (_, i) => ({ id: 1000 + i, artistId: 1, title: `Album ${i + 1}`, monitored: i === 500 }));
        const adapters = [lidarr(many)];
        const d = await buildDiagnose({ adapters, library: new LibraryLoader(adapters, undefined) }, { service: 'lidarr', id: '1' });
        expect(d.verdict.next_steps?.map(s => s.tool)).toEqual(['trigger_search']);
    });

    it('diagnoses an artist by id that the library read does not hold', async () => {
        const adapters = [Object.assign(lidarr(), { listLibrary: async () => [] })];
        const d = await buildDiagnose({ adapters, library: new LibraryLoader(adapters, undefined) }, { service: 'lidarr', id: '1' });
        expect(d.resolved?.kind).toBe('artist');
        expect(d.verdict.stage).toBe('file');
    });

    it('prefers a film over an artist of the same name, and diagnoses the artist when alone', async () => {
        const sameName: IndexInput = { ...FILM, title: '<<untrusted:radarr.title>>Daft Punk<</>>', ids: { tmdb: 77 } };
        const both = [stub('radarr', { listLibrary: async () => [sameName], getQueue: async () => [] }), lidarr()];
        const film = await buildDiagnose({ adapters: both, library: new LibraryLoader(both, undefined) }, { query: 'daft punk' });
        expect(film.resolved?.kind).toBe('movie');

        const alone = [lidarr()];
        const artist = await buildDiagnose({ adapters: alone, library: new LibraryLoader(alone, undefined) }, { query: 'daft punk' });
        expect(artist.resolved?.kind).toBe('artist');
    });

    it('never reads Seerr, Bazarr or a cleanup service for an artist', async () => {
        const reads: string[] = [];
        const track = (name: string) => async () => {
            reads.push(name);
            throw new Error('down');
        };
        const withFiles: IndexInput = {
            kind: 'artist',
            title: '<<untrusted:lidarr.title>>Daft Punk<</>>',
            // A tmdb id, so the cleanup read is kept off by the artist kind and not by this id's absence
            ids: { mbid: '056e4f3e-d505-4dad-8ec1-d04f521cbb56', tmdb: 4242 },
            acquisition: { service: 'lidarr', id: '1', monitored: true, hasFile: true }
        };
        const adapters = [
            Object.assign(lidarr(), { listLibrary: async () => [withFiles] }),
            stub('seerr', { getRequests: track('seerr') }),
            stub('bazarr', { getMissingSubtitles: track('bazarr'), getMissingSubtitlesFor: track('bazarr') }),
            stub('reclaimerr', { readCleanupStatus: track('reclaimerr') })
        ];
        const d = await buildDiagnose({ adapters, library: new LibraryLoader(adapters, undefined) }, { query: 'daft punk' });

        expect(reads).toEqual([]);
        expect(d.degraded).toEqual([]);
        expect(d.steps.find(s => s.stage === 'request')).toMatchObject({ status: 'skipped', detail: expect.stringMatching(/Seerr does not handle music/) });
        expect(d.steps.find(s => s.stage === 'subtitles')?.status).toBe('skipped');
    });

    it('reads the resolved title’s requests from Seerr, not the whole history', async () => {
        const reads: string[] = [];
        const base = deps();
        const adapters = base.adapters.map(a =>
            a.id !== 'seerr'
                ? a
                : stub('seerr', {
                      getRequests: async () => {
                          reads.push('list');
                          return [];
                      },
                      getMediaRequests: async (t: string, id: number) => {
                          reads.push(`${t}:${id}`);
                          return { requests: [{ service: 'seerr', id: 1, status: 'pending', mediaType: 'movie', tmdbId: 550, requestedBy: 'x' }] };
                      }
                  })
        );
        const d = await buildDiagnose({ adapters, library: new LibraryLoader(adapters, undefined) }, { query: 'some film' });
        expect(reads).toEqual(['movie:550']);
        expect(d.verdict.stage).toBe('request');
    });

    it('does not count an unreachable Lidarr against a film', async () => {
        const adapters = [
            stub('radarr', { listLibrary: async () => [FILM], getQueue: async () => [], queueKind: 'movie' }),
            stub('lidarr', {
                queueKind: 'artist',
                listLibrary: async () => {
                    throw new ServiceError('Unreachable', 'lidarr', 'connection refused');
                },
                getQueue: async () => {
                    throw new ServiceError('Unreachable', 'lidarr', 'connection refused');
                }
            })
        ];
        const d = await buildDiagnose({ adapters, library: new LibraryLoader(adapters, undefined) }, { query: 'some film' });

        expect(d.resolved?.kind).toBe('movie');
        expect(d.steps.find(s => s.stage === 'queue')?.status).toBe('skipped');
        expect(d.verdict).toMatchObject({ stage: 'file', certain: true });
    });

    it('counts an unreachable Lidarr against an artist', async () => {
        const down = Object.assign(lidarr(), {
            getQueue: async () => {
                throw new ServiceError('Unreachable', 'lidarr', 'connection refused');
            }
        });
        const adapters = [down];
        const d = await buildDiagnose({ adapters, library: new LibraryLoader(adapters, undefined) }, { service: 'lidarr', id: '1' });

        expect(d.steps.find(s => s.stage === 'queue')?.status).toBe('unknown');
        expect(d.degraded).toContain('lidarr');
        expect(d.verdict.certain).toBe(false);
    });

    describe('with a media server that reads music', () => {
        const identity = { resolve: async () => ({ id: 'u1', name: 'Someone' }), hasDefaultUser: true } as unknown as IdentityResolver;
        const MBID = '056e4f3e-d505-4dad-8ec1-d04f521cbb56';
        const server = (music: () => Promise<IndexInput[]>): ServiceAdapter =>
            stub('jellyfin', {
                listUserLibrary: async () => [],
                listUserMusic: music,
                getScanState: async () => ({ service: 'jellyfin', lastCompleted: '2026-08-05T02:00:00Z' })
            });

        it('does not say the server cannot see an artist when its music read failed', async () => {
            const onDisk = {
                service: 'lidarr',
                kind: 'artist',
                id: '1',
                title: '<<untrusted:lidarr.title>>Daft Punk<</>>',
                monitored: true,
                hasFile: true,
                ids: { mbid: MBID }
            };
            const adapters = [
                Object.assign(lidarr(), { listLibrary: async () => [], getMediaDetails: async () => onDisk }),
                server(async () => {
                    throw new ServiceError('Unreachable', 'jellyfin', 'connection refused');
                })
            ];
            const d = await buildDiagnose({ adapters, library: new LibraryLoader(adapters, identity) }, { service: 'lidarr', id: '1' });

            expect(d.steps.find(s => s.stage === 'library')?.status).toBe('unknown');
            expect(d.verdict.stage).not.toBe('library');
            expect(d.verdict.certain).toBe(false);
            expect(JSON.stringify(d.verdict.next_steps ?? [])).not.toContain('trigger_scan');
        });

        it('diagnoses the Lidarr artist when a server-only artist ranks ahead of it', async () => {
            // No MusicBrainz id on the server's side, so the two do not join.
            const lidarrSide: IndexInput = {
                kind: 'artist',
                title: '<<untrusted:lidarr.title>>Daft Punk Experience<</>>',
                ids: { mbid: MBID },
                acquisition: { service: 'lidarr', id: '1', monitored: true, hasFile: false }
            };
            const serverSide: IndexInput = {
                kind: 'artist',
                title: '<<untrusted:jellyfin.title>>Daft Punk<</>>',
                ids: {},
                playback: { user: 'Someone', itemId: 'j1' }
            };
            const adapters = [Object.assign(lidarr(), { listLibrary: async () => [lidarrSide] }), server(async () => [serverSide])];
            const d = await buildDiagnose({ adapters, library: new LibraryLoader(adapters, identity) }, { query: 'daft punk' });

            expect(d.resolved?.title).toContain('Daft Punk Experience');
            expect(d.steps.find(s => s.stage === 'managed')?.status).toBe('ok');
        });

        it('keeps a server-only artist with the exact name over a Radarr-held film that merely contains it', async () => {
            const serverSide: IndexInput = {
                kind: 'artist',
                title: '<<untrusted:jellyfin.title>>Daft Punk<</>>',
                ids: {},
                playback: { user: 'Someone', itemId: 'j1' }
            };
            const film: IndexInput = { ...FILM, title: '<<untrusted:radarr.title>>The Story of Daft Punk<</>>', ids: { tmdb: 77 } };
            // A Lidarr with no artists, because the server's music is only read when one is configured.
            const adapters = [
                stub('radarr', { listLibrary: async () => [film], getQueue: async () => [] }),
                Object.assign(lidarr(), { listLibrary: async () => [] }),
                server(async () => [serverSide])
            ];
            const d = await buildDiagnose({ adapters, library: new LibraryLoader(adapters, identity) }, { query: 'daft punk' });

            expect(d.resolved?.kind).toBe('artist');
        });

        it('still resolves a query that only films match, with the year', async () => {
            const alien = (title: string, year: number, tmdb: number): IndexInput => ({
                ...FILM,
                title: `<<untrusted:radarr.title>>${title}<</>>`,
                year,
                ids: { tmdb }
            });
            const adapters = [
                stub('radarr', { listLibrary: async () => [alien('Alien', 1979, 348), alien('Alien', 2024, 945961)], getQueue: async () => [] }),
                server(async () => [])
            ];
            const deps = { adapters, library: new LibraryLoader(adapters, identity) };
            expect((await buildDiagnose(deps, { query: 'Alien (1979)' })).resolved).toMatchObject({ kind: 'movie', year: 1979 });
            expect((await buildDiagnose(deps, { query: 'alien' })).resolved?.kind).toBe('movie');
        });
    });

    it('reads only artist queues and download clients for an artist', async () => {
        const read: string[] = [];
        const queue = (id: string) => async () => {
            read.push(id);
            return [];
        };
        const adapters = [
            lidarr(),
            stub('radarr', { getQueue: queue('radarr'), queueKind: 'movie' }),
            stub('sonarr', { getQueue: queue('sonarr'), queueKind: 'series' }),
            stub('sabnzbd', { getQueue: queue('sabnzbd') })
        ];
        await collectEvidence({ adapters, library: new LibraryLoader(adapters, undefined) }, { query: 'daft punk' });
        expect(read).toEqual(['sabnzbd']);
    });

    it('names the parameters when given neither', async () => {
        await expect(buildDiagnose(deps(), {})).rejects.toThrow(/query.*service.*id/i);
    });

    describe('a title that does not resolve', () => {
        const counting = () => {
            const calls: string[] = [];
            let historyReads = 0;
            const adapters = [
                stub('sabnzbd', {
                    getQueue: async () => [],
                    readHistory: async () => {
                        historyReads += 1;
                        return [];
                    }
                }),
                stub('radarr', {
                    listLibrary: async () => [FILM],
                    getQueue: async () => {
                        calls.push('queue');
                        return [];
                    }
                }),
                stub('prowlarr', {
                    getIndexers: async () => [],
                    getRecentRejections: async () => {
                        calls.push('rejections');
                        return [];
                    }
                }),
                stub('seerr', {
                    getRequests: async () => {
                        calls.push('requests');
                        throw new Error('down');
                    }
                })
            ];
            return { calls, get historyReads() { return historyReads; }, deps: { adapters, library: new LibraryLoader(adapters, undefined) } };
        };
        it('reads nothing past the library, so Seerr cannot make it uncertain', async () => {
            const c = counting();
            const result = await buildDiagnose(c.deps, { query: 'nothing like this' });
            expect(c.calls).toEqual([]);
            // the history read is what answers a miss, so it still happens
            expect(c.historyReads).toBe(1);
            expect(result.verdict.certain).toBe(true);
            expect(result.degraded).not.toContain('seerr');
        });
        it('is still read in full once a title resolves', async () => {
            const { calls, deps: d } = counting();
            await buildDiagnose(d, { query: 'some film' });
            expect([...calls].sort()).toEqual(['queue', 'rejections', 'requests']);
        });
    });

    it('reports a title it cannot resolve rather than throwing', async () => {
        // Unlike get_media_details: "we have never heard of this" is a
        // diagnosis, and the most common one a user starts from.
        const d = await buildDiagnose(deps(), { query: 'nothing like this' });
        expect(d.verdict.stage).toBe('resolve');
    });

    it('stays within budget — a diagnosis is prose, not a list', async () => {
        const d = await buildDiagnose(deps(), { query: 'some film' });
        expect(JSON.stringify(d).length).toBeLessThan(4_000);
    });

    // --- Fix round 1 ---

    // Jellyfin's id reports no kind, so `movie` stands in, and the Sonarr whose
    // read failed may be the one managing it.
    it('does not call a Jellyfin id unmanaged while an *arr of any kind could not be read', async () => {
        const adapters = [
            stub('sonarr', {
                listLibrary: async () => {
                    throw new ServiceError('Unreachable', 'sonarr', 'connection refused');
                }
            }),
            stub('jellyfin', {
                listUserLibrary: async () => [],
                getMediaDetails: async () => ({ service: 'jellyfin', kind: 'item', id: 'abc123', title: 'A Series', ids: { tvdb: 900 } })
            })
        ];
        const deps = { adapters, library: new LibraryLoader(adapters, undefined) };

        const evidence = await collectEvidence(deps, { service: 'jellyfin', id: 'abc123' });
        expect(evidence.itemKindGuessed).toBe(true);
        expect(evidence.libraryDegraded).toContain('sonarr');

        const d = await buildDiagnose(deps, { service: 'jellyfin', id: 'abc123' });
        expect(d.steps.find(s => s.stage === 'managed')).toMatchObject({ status: 'unknown', service: 'sonarr' });
        expect(d.verdict).toMatchObject({ stage: 'managed', certain: false });
    });

    it('lists the configured *arr instances, and no other service, for the managed remedy', async () => {
        const adapters = [
            stub('radarr/4k', { listLibrary: async () => [] }),
            stub('whisparr', { listLibrary: async () => [] }),
            stub('sabnzbd', {}),
            stub('jellyfin', {
                listUserLibrary: async () => [],
                getMediaDetails: async () => ({ service: 'jellyfin', kind: 'item', id: 'abc123', title: fenceText('A Title', { service: 'jellyfin', field: 'Name' }), ids: { tmdb: 900 } })
            })
        ];
        const deps = { adapters, library: new LibraryLoader(adapters, undefined) };
        const evidence = await collectEvidence(deps, { service: 'jellyfin', id: 'abc123' });
        expect(evidence.arrs).toEqual(['radarr/4k', 'whisparr']);
        const d = await buildDiagnose(deps, { service: 'jellyfin', id: 'abc123' });
        expect(d.verdict).toMatchObject({ stage: 'managed', remedy: 'Add it to Radarr or Whisparr.' });
    });

    it('Finding F: diagnoses a Jellyfin item as the series Sonarr already manages, not a fabricated unmanaged movie', async () => {
        // JellyfinAdapter.getMediaDetails reports kind: 'item' for everything.
        // Coercing that to 'movie' before calling find() used to restrict the
        // lookup to the movie keyspace and silently miss this series, which
        // is genuinely sitting in the index under sonarr's acquisition.
        const SERIES: IndexInput = {
            kind: 'series',
            title: '<<untrusted:sonarr.title>>A Series<</>>',
            ids: { tvdb: 900 },
            acquisition: { service: 'sonarr', monitored: true, hasFile: false }
        };
        const adapters = [
            stub('sonarr', { listLibrary: async () => [SERIES] }),
            stub('jellyfin', {
                getMediaDetails: async () => ({
                    service: 'jellyfin',
                    kind: 'item',
                    id: 'abc123',
                    title: 'A Series',
                    ids: { tvdb: 900 }
                })
            })
        ];

        const d = await buildDiagnose(
            { adapters, library: new LibraryLoader(adapters, undefined) },
            { service: 'jellyfin', id: 'abc123' }
        );

        expect(d.resolved?.kind).toBe('series');
        // Found in the index, so the kind is known, not guessed.
        expect((await collectEvidence({ adapters, library: new LibraryLoader(adapters, undefined) }, { service: 'jellyfin', id: 'abc123' })).itemKindGuessed).toBeUndefined();
        // The bug fabricated a kind: 'movie' record with no acquisition at
        // all, verdicting 'managed' ("Neither Radarr nor Sonarr is managing
        // it") at certain: true. The real join has Sonarr monitoring it with
        // no file yet, so the true verdict is 'file'.
        expect(d.verdict.stage).toBe('file');
    });

    it('Finding A: throws, rather than reporting "nothing matches", for an explicit service that cannot answer media details', async () => {
        // get_media_details' schema accepts every ServiceId, but only Radarr,
        // Sonarr and Jellyfin implement getMediaDetails. Naming any other
        // configured service (e.g. sabnzbd) used to resolve silently to
        // `undefined`, which the chain then reports as a confident
        // "Nothing in your stack matches" — a false negative about a real
        // configuration mistake, not a real absence.
        await expect(buildDiagnose(deps(), { service: 'sabnzbd', id: '1' })).rejects.toThrow(
            /sabnzbd.*not configured/i
        );
    });

    it('Finding B, repaired by Task 7: a tvdb-only series with Seerr configured is now checked directly, not reported as "could not determine"', async () => {
        // SonarrAdapter.listLibrary never emits a tmdb id — only tvdb/imdb.
        // Without Jellyfin to supply a tmdb id, every series diagnosis on a
        // Sonarr+Seerr stack used to read the missing tmdb id as "could not
        // determine" (status: 'unknown', certain: false) — a retraction, not
        // a real answer, even when Seerr had genuinely been asked.
        //
        // Seerr's request payload carries a tvdbId too (MediaInfo.tvdbId,
        // confirmed against the vendored OpenAPI spec), so the matcher in
        // evidence.ts now falls back to it. With no matching request at all,
        // the diagnosis can now confidently say so instead of retracting.
        const SERIES_NO_TMDB: IndexInput = {
            kind: 'series',
            title: '<<untrusted:sonarr.title>>A Series<</>>',
            ids: { tvdb: 700 },
            acquisition: { service: 'sonarr', monitored: true, hasFile: false }
        };
        const adapters = [
            stub('sonarr', { listLibrary: async () => [SERIES_NO_TMDB] }),
            stub('seerr', { getRequests: async () => [] })
        ];

        const d = await buildDiagnose(
            { adapters, library: new LibraryLoader(adapters, undefined) },
            { query: 'a series' }
        );

        expect(d.steps.find(s => s.stage === 'request')).toMatchObject({
            status: 'skipped',
            detail: 'No request recorded. Not everything arrives through Seerr.'
        });
        expect(d.verdict.certain).toBe(true);
    });

    it('matches a Seerr request on tvdb id alone, closing the gap Finding B documented', async () => {
        // The other half of the repair: a pending request keyed only by
        // tvdbId (as every Sonarr series request is, absent a tmdb id) must
        // actually be found, not just correctly reported absent.
        const SERIES_NO_TMDB: IndexInput = {
            kind: 'series',
            title: '<<untrusted:sonarr.title>>A Series<</>>',
            ids: { tvdb: 700 },
            acquisition: { service: 'sonarr', monitored: true, hasFile: false }
        };
        const adapters = [
            stub('sonarr', { listLibrary: async () => [SERIES_NO_TMDB] }),
            stub('seerr', {
                getRequests: async () => [
                    { service: 'seerr', id: 1, status: 'pending', mediaType: 'tv', tvdbId: 700, requestedBy: 'Someone' }
                ]
            })
        ];

        const d = await buildDiagnose(
            { adapters, library: new LibraryLoader(adapters, undefined) },
            { query: 'a series' }
        );

        expect(d.verdict.stage).toBe('request');
        expect(d.steps.find(s => s.stage === 'request')).toMatchObject({
            status: 'blocked',
            detail: 'The request is still awaiting approval.'
        });
    });

    it('collects a partially-read queue as {items, partial}, not undefined, when only some clients answer', async () => {
        const adapters = [
            stub('radarr', {
                listLibrary: async () => [FILM],
                getQueue: async () => [{ service: 'radarr', id: '1', title: 'Some.Film.2026.1080p', status: 'downloading' }]
            }),
            stub('sabnzbd', {
                getQueue: async () => {
                    throw new Error('down');
                }
            })
        ];

        const evidence = await collectEvidence(
            { adapters, library: new LibraryLoader(adapters, undefined) },
            { query: 'some film' }
        );

        expect(evidence.queue).toEqual({
            items: [{ service: 'radarr', id: '1', title: 'Some.Film.2026.1080p', status: 'downloading' }],
            partial: ['sabnzbd']
        });
        expect(evidence.degraded).toContain('sabnzbd');
    });

    it('leaves an artist queue out, so an unreachable Lidarr cannot make a film\'s queue unknown', async () => {
        let lidarrReads = 0;
        const adapters = [
            stub('radarr', { listLibrary: async () => [FILM], getQueue: async () => [], queueKind: 'movie' }),
            stub('lidarr', {
                queueKind: 'artist',
                getQueue: async () => {
                    lidarrReads += 1;
                    throw new Error('down');
                }
            })
        ];

        const evidence = await collectEvidence(
            { adapters, library: new LibraryLoader(adapters, undefined) },
            { query: 'some film' }
        );

        expect(lidarrReads).toBe(0);
        expect(evidence.queue).toEqual({ items: [], partial: [] });
        expect(evidence.degraded).not.toContain('lidarr');
    });

    it('reads a series queue and a download client\'s, which has no kind', async () => {
        const read: string[] = [];
        const queue = (id: string) => async () => {
            read.push(id);
            return [];
        };
        const adapters = [
            stub('radarr', { listLibrary: async () => [FILM] }),
            stub('sonarr', { getQueue: queue('sonarr'), queueKind: 'series' }),
            stub('sabnzbd', { getQueue: queue('sabnzbd') })
        ];

        await collectEvidence({ adapters, library: new LibraryLoader(adapters, undefined) }, { query: 'some film' });

        expect(read.sort()).toEqual(['sabnzbd', 'sonarr']);
    });

    it('collapses the queue to undefined only when every configured client fails, not when one of several does', async () => {
        const adapters = [
            stub('radarr', {
                listLibrary: async () => [FILM],
                getQueue: async () => {
                    throw new Error('down');
                }
            }),
            stub('sabnzbd', {
                getQueue: async () => {
                    throw new Error('down too');
                }
            })
        ];

        const evidence = await collectEvidence(
            { adapters, library: new LibraryLoader(adapters, undefined) },
            { query: 'some film' }
        );

        expect(evidence.queue).toBeUndefined();
        expect(evidence.queueConfigured).toBe(true);
        expect(evidence.degraded).toEqual(['radarr', 'sabnzbd']);
    });

    it('reports queueConfigured/prowlarrConfigured/jellyfinConfigured as false, not merely absent, when no such service exists', async () => {
        const adapters = [stub('radarr', { listLibrary: async () => [FILM] })];

        const evidence = await collectEvidence(
            { adapters, library: new LibraryLoader(adapters, undefined) },
            { query: 'some film' }
        );

        expect(evidence.queueConfigured).toBe(false);
        expect(evidence.prowlarrConfigured).toBe(false);
        expect(evidence.mediaServer).toBeUndefined();
        expect(evidence.scanCapable).toBe(false);
        expect(evidence.queue).toBeUndefined();
        expect(evidence.rejections).toBeUndefined();
        expect(evidence.scan).toBeUndefined();
    });

    it('reports the library half configured even when the media server cannot report scan state', async () => {
        const noScan = stub('jellyfin', {
            listUserLibrary: async () => [],
            getPlayback: async () => [],
            getNextUp: async () => [],
            getWatchHistory: async () => [],
            listUsers: async () => [{ id: 'u1', name: 'Someone' }]
        });
        const adapters = [stub('radarr', { listLibrary: async () => [FILM] }), noScan];

        const evidence = await collectEvidence(
            { adapters, library: new LibraryLoader(adapters, undefined) },
            { query: 'some film' }
        );

        expect(evidence.mediaServer).toBe('jellyfin');
        expect(evidence.scanCapable).toBe(false);
        expect(evidence.scan).toBeUndefined();
    });

    // --- Item 2 of the whole-phase review: library-read reachability must
    // not be conflated with diagnose's own probe reachability. ---

    it('does not let a failing Jellyfin scan probe erase a library read that succeeded', async () => {
        // Reproduction: getScanState failing used to push 'jellyfin' into the
        // same flat `degraded` array the library read's own failures used,
        // so libraryStep read it as "the library was not checked" even
        // though the library read (listUserLibrary, via the loader) never
        // failed at all — discarding the flagship `library` verdict.
        const FILM_WITH_FILE: IndexInput = {
            kind: 'movie',
            title: '<<untrusted:radarr.title>>Some Film<</>>',
            year: 2026,
            ids: { tmdb: 550 },
            acquisition: { service: 'radarr', monitored: true, hasFile: true }
        };
        const jellyfin = stub('jellyfin', {
            listUserLibrary: async () => [],
            getScanState: async () => {
                throw new ServiceError('Unreachable', 'jellyfin', 'connection refused');
            },
            listUsers: async () => [{ id: 'u1', name: 'Someone' }]
        }) as unknown as ServiceAdapter & UserDirectoryCapable;
        const adapters = [stub('radarr', { listLibrary: async () => [FILM_WITH_FILE], getQueue: async () => [] }), jellyfin];
        const identity = new IdentityResolver(jellyfin, { default_user: 'Someone', allow_other_users: false });

        const d = await buildDiagnose({ adapters, library: new LibraryLoader(adapters, identity) }, { query: 'some film' });

        // Jellyfin's library read genuinely succeeded and genuinely does not
        // have this item (empty listUserLibrary) — a real broken import, with
        // its own status and remedy. Before this fix, the failed scan probe
        // made libraryStep read `ev.degraded` (which the scan probe failure
        // also populated) and report status: 'unknown', detail: "Jellyfin
        // could not be reached, so its library was not checked" — a false
        // statement that also discarded this remedy.
        expect(d.steps.find(s => s.stage === 'library')).toMatchObject({
            status: 'blocked',
            detail: expect.stringContaining('cannot see')
        });
        expect(d.verdict.stage).toBe('library');
        // The remedy names the configured media server rather than a
        // hardcoded brand — asserted against the exact wording so a
        // regression back to a static string would fail here too.
        expect(d.verdict.remedy).toBe(
            'Trigger a jellyfin library scan. If it still does not appear, check the path is inside a jellyfin library and readable by it.'
        );
        // The scan probe itself did fail, and separately, legitimately, still
        // costs certainty here (a running scan could explain a transient
        // library gap) — this fix is about the `library` stage's own status
        // and remedy, not about retracting certainty for an unrelated reason.
        expect(d.steps.find(s => s.stage === 'scan')).toMatchObject({ status: 'unknown' });
        expect(d.verdict.certain).toBe(false);
    });

    it('does not let a failing Radarr library read erase a queue that answered in full', async () => {
        // Reproduction: a Radarr `listLibrary` failure used to land in the
        // same flat `degraded` array `queueStep` consulted for "which
        // download clients could not be fully checked", so the queue stage
        // reported unknown even though every configured queue (here, just
        // sabnzbd) answered completely.
        const SERIES: IndexInput = {
            kind: 'series',
            title: '<<untrusted:sonarr.title>>A Series<</>>',
            ids: { tvdb: 700 },
            acquisition: { service: 'sonarr', monitored: true, hasFile: false }
        };
        const adapters = [
            stub('radarr', {
                listLibrary: async () => {
                    throw new ServiceError('Unreachable', 'radarr', 'connection refused');
                }
            }),
            stub('sonarr', { listLibrary: async () => [SERIES] }),
            stub('sabnzbd', { getQueue: async () => [] })
        ];

        const d = await buildDiagnose(
            { adapters, library: new LibraryLoader(adapters, undefined) },
            { query: 'a series' }
        );

        expect(d.steps.find(s => s.stage === 'queue')).toMatchObject({ status: 'skipped' });
        expect(d.degraded).toContain('radarr');
    });

    it('propagates an identity refusal as a thrown error rather than a degraded stage', async () => {
        // §9's gate: naming a user other than the configured default without
        // allow_other_users must reach the caller as a refusal, not as "the
        // library could not be read" — a model told the latter would retry
        // forever instead of stopping.
        const jellyfin = stub('jellyfin', {
            listUsers: async () => [{ id: '1', name: 'alice' }]
        }) as unknown as ServiceAdapter & UserDirectoryCapable;
        const identity = new IdentityResolver(jellyfin, { default_user: 'alice', allow_other_users: false });
        const adapters = [stub('radarr', { listLibrary: async () => [FILM] }), jellyfin];
        const library = new LibraryLoader(adapters, identity);

        await expect(buildDiagnose({ adapters, library }, { query: 'some film', user: 'bob' })).rejects.toThrow(
            /not permitted/i
        );
    });
    describe('a Grimmory book', () => {
        const seen: string[] = [];
        const grimmory = (): GrimmoryAdapter =>
            new GrimmoryAdapter(
                { url: 'http://grimmory:6060', username: 'reader', password: 'pw', timeout_ms: 10_000 } as never,
                (async (input: string | URL | Request) => {
                    seen.push(String(input));
                    return new Response('{}', { status: 200 });
                }) as unknown as typeof fetch
            );

        it('is refused before the chain is walked', async () => {
            seen.length = 0;
            const adapters = [stub('radarr', { listLibrary: async () => [FILM] }), grimmory()];
            const run = buildDiagnose({ adapters, library: new LibraryLoader(adapters, undefined) }, { service: 'grimmory', id: '58' });
            await expect(run).rejects.toThrow(/never passes through the diagnosis chain/);
            await expect(run).rejects.toThrow(/get_media_details/);
            await expect(run).rejects.toThrow(/get_stack_health/);
            expect(seen).toEqual([]);
        });

        it('is not matched by a title', async () => {
            // The book is in the index: Grimmory lists it for get_library. Diagnose
            // by title reads the film, series and artist rows only, so it still
            // resolves to nothing rather than to the book.
            const BOOK: IndexInput = {
                kind: 'book',
                title: '<<untrusted:grimmory.title>>Example Book 58 by Example Author 1<</>>',
                ids: {},
                acquisition: { service: 'grimmory', id: '58', monitored: false, hasFile: true, quality: 'EPUB' }
            };
            const adapters = [stub('radarr', { listLibrary: async () => [FILM] }), stub('grimmory', { listLibrary: async () => [BOOK] })];
            const library = new LibraryLoader(adapters, undefined);
            expect((await library.load()).index.search('Example Book 58').map(i => i.kind)).toEqual(['book']);

            const d = await buildDiagnose({ adapters, library }, { query: 'Example Book 58' });
            expect(d.resolved).toBeUndefined();
        });

        it('a Grimmory outage does not hedge a film answer', async () => {
            const down = stub('grimmory', {
                listLibrary: async () => {
                    throw new Error('grimmory down');
                }
            });
            const adapters = [stub('radarr', { listLibrary: async () => [FILM] }), down];
            const library = new LibraryLoader(adapters, undefined);
            expect((await library.load()).degraded).toContain('grimmory');

            const missing = await buildDiagnose({ adapters, library }, { query: 'No Such Film' });
            expect(missing.resolved).toBeUndefined();
            expect(missing.verdict.certain).toBe(true);
            expect(missing.degraded).not.toContain('grimmory');
        });
    });
});

describe('two media servers', () => {
    const FILM_WITH_FILE: IndexInput = { ...FILM, acquisition: { service: 'radarr', monitored: true, hasFile: true } };
    const mediaServer = (id: string, listUserLibrary: () => Promise<IndexInput[]>) =>
        stub(id, {
            listUserLibrary,
            getScanState: async () => ({ service: id, lastCompleted: '2026-08-05T02:00:00Z' }),
            listUsers: async () => [{ id: 'u1', name: 'Someone' }]
        }) as unknown as ServiceAdapter & UserDirectoryCapable;
    const setup = (plexLibrary: () => Promise<IndexInput[]>, primary: string) => {
        const plex = mediaServer('plex', plexLibrary);
        const jellyfin = mediaServer('jellyfin', async () => [FILM_WITH_FILE]);
        const adapters = [stub('radarr', { listLibrary: async () => [FILM_WITH_FILE], getQueue: async () => [] }), plex, jellyfin];
        const identity = (a: ServiceAdapter & UserDirectoryCapable) =>
            new IdentityResolver(a, { default_user: 'Someone', allow_other_users: false });
        const secondary = primary === 'jellyfin' ? plex : jellyfin;
        const library = new LibraryLoader(adapters, identity(primary === 'jellyfin' ? jellyfin : plex), undefined, undefined, {
            primaryId: primary,
            secondary: { id: secondary.id, identity: identity(secondary as ServiceAdapter & UserDirectoryCapable) }
        });
        return { adapters, library };
    };

    it('reports the media server the deps name as primary', async () => {
        const evidence = await collectEvidence(
            { ...setup(async () => [], 'jellyfin'), primaryMediaServer: 'jellyfin' },
            { query: 'some film' }
        );

        expect(evidence.mediaServer).toBe('jellyfin');
        const other = await collectEvidence(
            { ...setup(async () => [], 'plex'), primaryMediaServer: 'plex' },
            { query: 'some film' }
        );
        expect(other.mediaServer).toBe('plex');
    });

    it('does not claim the primary has an item that only the secondary was named for', async () => {
        const { adapters, library } = setup(async () => [], 'plex');
        const jellyfin = adapters.find(a => a.id === 'jellyfin') as unknown as Record<string, unknown>;
        jellyfin.getMediaDetails = async () => ({
            service: 'jellyfin',
            kind: 'item',
            id: 'jf1',
            title: 'Only On Jellyfin',
            ids: { tmdb: 4242 }
        });
        const deps = { adapters, library, primaryMediaServer: 'plex' };

        const evidence = await collectEvidence(deps, { service: 'jellyfin', id: 'jf1' });
        expect(evidence.item?.presence).toBe('unknown');
        expect(evidence.item?.media_servers).toEqual({ jellyfin: { present: true, itemId: 'jf1' } });

        const d = await buildDiagnose(deps, { service: 'jellyfin', id: 'jf1' });
        const text = JSON.stringify(d);
        expect(text).not.toMatch(/Present in the plex library/);
        expect(text).toMatch(/jellyfin library/);
    });

    it('still diagnoses a primary-named id as present in the primary', async () => {
        const { adapters, library } = setup(async () => [], 'plex');
        const plex = adapters.find(a => a.id === 'plex') as unknown as Record<string, unknown>;
        plex.getMediaDetails = async () => ({
            service: 'plex',
            kind: 'item',
            id: 'p1',
            title: 'Only On Plex',
            ids: { tmdb: 4243 }
        });
        const evidence = await collectEvidence({ adapters, library, primaryMediaServer: 'plex' }, { service: 'plex', id: 'p1' });
        expect(evidence.item?.presence).toBe('jellyfin_only');
        expect(evidence.item?.media_servers).toBeUndefined();
    });

    it('does not let a down secondary lower certainty or mark a stage unknown', async () => {
        const down = async (): Promise<IndexInput[]> => {
            throw new ServiceError('Unreachable', 'plex', 'connection refused');
        };
        const healthyRun = await buildDiagnose(
            { ...setup(async () => [FILM_WITH_FILE], 'jellyfin'), primaryMediaServer: 'jellyfin' },
            { query: 'some film' }
        );
        const downRun = await buildDiagnose(
            { ...setup(down, 'jellyfin'), primaryMediaServer: 'jellyfin' },
            { query: 'some film' }
        );

        // The summary differs only by the healthy run's "Also in the plex library."
        expect(downRun.verdict).toMatchObject({ stage: healthyRun.verdict.stage, certain: healthyRun.verdict.certain });
        expect(downRun.verdict.certain).toBe(true);
        expect(downRun.steps.map(s => [s.stage, s.status])).toEqual(healthyRun.steps.map(s => [s.stage, s.status]));
        expect(downRun.steps.find(s => s.stage === 'library')?.detail).not.toMatch(/plex/);
        expect(downRun.degraded).not.toContain('plex');
    });
});

describe('a definitive answer is not an outage', () => {
    /**
     * `probe` catches everything, so the NotFound a nonexistent id produces
     * pushed the adapter into `degraded` and answered "radarr could not be
     * checked" — steering the caller toward reporting an outage rather than
     * fixing the id. get_media_details throws legibly in the same situation.
     */
    it('reports a bad id as not found rather than degrading the service', async () => {
        const adapters = [
            stub('radarr', {
                listLibrary: async () => [FILM],
                getQueue: async () => [],
                getMediaDetails: async () => {
                    throw new ServiceError('NotFound', 'radarr', 'radarr not found: no movie with id 9999');
                }
            })
        ];
        const withMissing: DiagnoseDeps = { adapters, library: new LibraryLoader(adapters, undefined) };

        await expect(buildDiagnose(withMissing, { service: 'radarr', id: '9999' })).rejects.toThrow(/not found/i);
    });

    it('still degrades when the service is unreachable', async () => {
        const adapters = [
            stub('radarr', {
                listLibrary: async () => [FILM],
                getQueue: async () => [],
                getMediaDetails: async () => {
                    throw new ServiceError('Unreachable', 'radarr', 'radarr unreachable: connection refused');
                }
            })
        ];
        const withDown: DiagnoseDeps = { adapters, library: new LibraryLoader(adapters, undefined) };

        const d = await buildDiagnose(withDown, { service: 'radarr', id: '1' });
        expect(d.degraded).toContain('radarr');
    });
});

describe('scoping that cannot be applied', () => {
    // A query is answered from the merged index, which has no per-service
    // keyspace to narrow — so a service or instance alongside one was silently
    // dropped, answering a different question than the one asked.
    it('refuses a query scoped to a service', async () => {
        await expect(collectEvidence(deps(), { query: 'some film', service: 'radarr' })).rejects.toThrow(
            /only apply when diagnosing by id/i
        );
    });

    it('refuses a query scoped to an instance', async () => {
        await expect(collectEvidence(deps(), { query: 'some film', instance: '4k' })).rejects.toThrow(
            /only apply when diagnosing by id/i
        );
    });

    it('still accepts a query on its own, and a service with an id', async () => {
        await expect(collectEvidence(deps(), { query: 'some film' })).resolves.toBeDefined();
    });
});

describe('collectEvidence — Cleanuparr', () => {
    const event = (id: string, downloadId: string) => ({
        service: 'cleanuparr',
        id,
        at: '2026-10-09T12:00:00+00:00',
        event: 'deleted',
        title: 'x',
        downloadId
    });
    const film = { ...FILM, acquisition: { service: 'radarr', id: '7', monitored: true, hasFile: false } };
    const radarr = stub('radarr', {
        listLibrary: async () => [film],
        getQueue: async () => [],
        readHistory: async () => ({ items: [{ service: 'radarr', id: 'h1', at: '2026-10-08T00:00:00Z', event: 'grabbed', title: 'x', downloadId: 'aaaa1111' }], total: 1 })
    });
    const run = (cleanuparr: ServiceAdapter | undefined) => {
        const adapters = cleanuparr === undefined ? [radarr] : [radarr, cleanuparr];
        return collectEvidence({ adapters, library: new LibraryLoader(adapters, undefined) }, { query: 'some film' });
    };

    it('keeps only the events whose download id matches the item', async () => {
        const evidence = await run(
            stub('cleanuparr', {
                getSeedingRules: async () => [],
                readHistory: async () => ({ items: [event('e1', 'aaaa1111'), event('e2', 'zzzz9999')], total: 2 })
            })
        );
        expect(evidence.cleanuparr?.map(e => e.id)).toEqual(['e1']);
    });

    it('is undefined, and degraded, when Cleanuparr cannot be read', async () => {
        const evidence = await run(
            stub('cleanuparr', {
                getSeedingRules: async () => [],
                readHistory: async () => {
                    throw new Error('down');
                }
            })
        );
        expect(evidence.cleanuparr).toBeUndefined();
        expect(evidence.degraded).toContain('cleanuparr');
    });

    it('does not turn the queue unknown when only the *arr history read fails', async () => {
        const failing = stub('radarr', {
            listLibrary: async () => [film],
            getQueue: async () => [],
            readHistory: async () => {
                throw new Error('down');
            }
        });
        const cleanuparr = stub('cleanuparr', { getSeedingRules: async () => [], readHistory: async () => ({ items: [], total: 0 }) });
        const adapters = [failing, cleanuparr];
        const evidence = await collectEvidence({ adapters, library: new LibraryLoader(adapters, undefined) }, { query: 'some film' });
        expect(evidence.degraded).toContain('radarr:history');
        expect(evidence.degraded).not.toContain('radarr');
        expect(buildChain('some film', evidence).steps.find(s => s.stage === 'queue')?.status).not.toBe('unknown');
    });

    it('does not read Cleanuparr when the item has no download id', async () => {
        const noGrabs = stub('radarr', { listLibrary: async () => [film], getQueue: async () => [], readHistory: async () => ({ items: [], total: 0 }) });
        let calls = 0;
        const down = stub('cleanuparr', {
            getSeedingRules: async () => [],
            readHistory: async () => {
                calls += 1;
                throw new Error('down');
            }
        });
        const evidenceFor = (adapters: ServiceAdapter[]) => collectEvidence({ adapters, library: new LibraryLoader(adapters, undefined) }, { query: 'some film' });
        const evidence = await evidenceFor([noGrabs, down]);
        expect(calls).toBe(0);
        expect(evidence.degraded).not.toContain('cleanuparr');
        expect(evidence.cleanuparr).toEqual([]);
        const without = await evidenceFor([noGrabs]);
        expect(buildChain('some film', evidence).verdict.certain).toBe(buildChain('some film', without).verdict.certain);
    });

    it('is null when Cleanuparr is not configured', async () => {
        expect((await run(undefined)).cleanuparr).toBeNull();
    });
});

describe('diagnose — download history for a title no library has', () => {
    const fenced = (service: string, field: string, value: string) => `<<untrusted:${service}.${field}>>${value}<</>>`;
    const gone = (id: string, title: string, over: Record<string, unknown> = {}) => ({
        service: 'cleanuparr',
        id,
        at: '2026-10-27T05:45:10+00:00',
        event: 'deleted',
        rawEvent: 'DownloadCleaned',
        title: fenced('cleanuparr', 'itemTitle', title),
        downloadId: `hash-${id}`,
        ...over
    });

    const stack = (cleanuparrHistory: () => Promise<unknown>, sabHistory: unknown[] = []) => {
        const asked: unknown[] = [];
        const adapters = [
            stub('radarr', { listLibrary: async () => [FILM], getQueue: async () => [] }),
            stub('sabnzbd', { getQueue: async () => [], readHistory: async () => sabHistory }),
            stub('qbittorrent', { getQueue: async () => [] }),
            stub('cleanuparr', {
                getSeedingRules: async () => [],
                readHistory: async (opts: unknown) => {
                    asked.push(opts);
                    return cleanuparrHistory();
                }
            })
        ];
        return { asked, deps: { adapters, library: new LibraryLoader(adapters, undefined) } };
    };

    it('reports what Cleanuparr did to a release removed from Radarr', async () => {
        const { asked, deps: d } = stack(async () => ({
            items: [
                gone('e2', 'Gone.Film.2024.1080p.WEB-DL', { reason: fenced('cleanuparr', 'reason', 'MaxSeedTimeReached') }),
                gone('e1', 'Gone.Film.2024.1080p.WEB-DL', { at: '2026-10-20T00:00:00Z', event: 'strike', strikeCount: 2, downloadId: 'hash-e2' }),
                gone('e3', 'Another.Film.2024.1080p')
            ],
            total: 3
        }));
        const result = await buildDiagnose(d, { query: 'Gone Film 2024' });
        expect(result.verdict.stage).toBe('resolve');
        expect(result.verdict.summary).toMatch(/Cleanuparr removed .*Gone\.Film\.2024.* on 2026-10-27: .*MaxSeedTimeReached.*, after 2 strikes\./);
        expect(result.verdict.summary).not.toContain('Another.Film');
        expect(result.verdict.certain).toBe(true);
        expect(result.history?.map(h => h.id)).toEqual(['e2']);
        // Bounded: a window and a row cap, not the whole event log.
        expect(asked).toEqual([{ since: expect.any(String), want: 500 }]);
    });

    it('reads a usenet client’s own history too', async () => {
        const sab = { service: 'sabnzbd', id: 'SABnzbd_nzo_1', at: '2026-10-25T00:00:00Z', event: 'failed', title: fenced('sabnzbd', 'name', 'Gone_Film_2024_1080p'), reason: fenced('sabnzbd', 'fail_message', 'Out of retention') };
        const { deps: d } = stack(async () => ({ items: [], total: 0 }), [sab]);
        const result = await buildDiagnose(d, { query: 'gone film' });
        expect(result.verdict.summary).toMatch(/sabnzbd failed .*Gone_Film_2024.*Out of retention/);
    });

    it('keeps today’s answer when nothing in history matches', async () => {
        const { deps: d } = stack(async () => ({ items: [gone('e3', 'Another.Film.2024.1080p')], total: 1 }));
        const result = await buildDiagnose(d, { query: 'gone film' });
        expect(result.verdict.summary).toBe('Nothing in your stack matches "gone film".');
        expect(result.history).toBeUndefined();
    });

    it('is uncertain, not wrong, when Cleanuparr cannot be read', async () => {
        const { deps: d } = stack(async () => {
            throw new Error('down');
        });
        const result = await buildDiagnose(d, { query: 'gone film' });
        expect(result.verdict.summary).toBe('Nothing in your stack matches "gone film".');
        expect(result.verdict.certain).toBe(false);
        expect(result.degraded).toContain('cleanuparr');
    });

    it('does not read history by name when the query resolves', async () => {
        const { deps: d } = stack(async () => {
            throw new Error('must not be asked');
        });
        const evidence = await collectEvidence(d, { query: 'some film' });
        expect(evidence.history).toBeUndefined();
        expect(evidence.degraded).not.toContain('cleanuparr');
    });
});

describe('collectEvidence — Bazarr', () => {
    const owned = { ...FILM, acquisition: { service: 'radarr', id: '5', monitored: true, hasFile: true } };
    const gap = { service: 'bazarr', kind: 'movie', id: 5, title: 'Some Film', missing: [{ name: 'Dutch', code2: 'nl', forced: false, hearingImpaired: false }] };
    const radarr = (film: IndexInput) => stub('radarr', { listLibrary: async () => [film], getQueue: async () => [] });
    const bazarr = (read: (item?: unknown) => Promise<unknown[]>) =>
        stub('bazarr', { getMissingSubtitles: async () => { throw new Error('the whole wanted list must not be read'); }, getMissingSubtitlesFor: read, getProviders: async () => [] });
    const run = (adapters: ServiceAdapter[]) => collectEvidence({ adapters, library: new LibraryLoader(adapters, undefined) }, { query: 'some film' });

    it('reads what Bazarr is missing for an item with a file', async () => {
        const evidence = await run([radarr(owned), bazarr(async () => [gap])]);
        expect(evidence.subtitles).toEqual({ gaps: [gap], service: 'bazarr' });
    });

    it('asks Bazarr for this one item, not the whole wanted list', async () => {
        const asked: unknown[] = [];
        let all = 0;
        const adapter = stub('bazarr', {
            getMissingSubtitles: async () => {
                all += 1;
                return [];
            },
            getMissingSubtitlesFor: async (item: unknown) => {
                asked.push(item);
                return [gap];
            },
            getProviders: async () => []
        });
        await run([radarr(owned), adapter]);
        expect(asked).toEqual([{ kind: 'movie', id: 5 }]);
        expect(all).toBe(0);
    });

    it('asks Bazarr for a series by its series id', async () => {
        const asked: unknown[] = [];
        const series: IndexInput = {
            kind: 'series',
            title: '<<untrusted:sonarr.title>>Some Series<</>>',
            ids: { tvdb: 900 },
            acquisition: { service: 'sonarr', id: '67', monitored: true, hasFile: true }
        };
        const sonarr = stub('sonarr', { listLibrary: async () => [series], getQueue: async () => [] });
        await collectEvidence(
            { adapters: [sonarr, bazarr(async item => { asked.push(item); return []; })], library: new LibraryLoader([sonarr], undefined) },
            { query: 'some series' }
        );
        expect(asked).toEqual([{ kind: 'series', seriesId: 67 }]);
    });

    it('reads no Bazarr gaps when the item has no usable id', async () => {
        let calls = 0;
        const evidence = await run([
            radarr({ ...owned, acquisition: { ...owned.acquisition, id: 'x' } }),
            bazarr(async () => {
                calls += 1;
                return [gap];
            })
        ]);
        expect(calls).toBe(0);
        expect(evidence.subtitles).toEqual({ gaps: [], service: 'bazarr' });
    });

    it('is undefined, and degraded, when Bazarr cannot be read', async () => {
        const evidence = await run([
            radarr(owned),
            bazarr(async () => {
                throw new Error('down');
            })
        ]);
        expect(evidence.subtitles).toBeUndefined();
        expect(evidence.degraded).toContain('bazarr');
        expect(buildChain('some film', evidence).steps.find(s => s.stage === 'subtitles')?.status).toBe('unknown');
    });

    it('is null when Bazarr is not configured', async () => {
        expect((await run([radarr(owned)])).subtitles).toBeNull();
    });

    it('does not read Bazarr for an item with no file', async () => {
        let calls = 0;
        const evidence = await run([
            radarr(FILM),
            bazarr(async () => {
                calls += 1;
                return [gap];
            })
        ]);
        expect(calls).toBe(0);
        expect(evidence.degraded).not.toContain('bazarr');
    });
});

// TMDB's film and series ids are separate namespaces, so a number is not a title.
describe('diagnose and a request for another kind of title', () => {
    it('does not call a film waiting on a TV request that shares its TMDB id', async () => {
        const d = await buildDiagnose(
            deps({ requests: [{ service: 'seerr', id: 77, status: 'pending', mediaType: 'tv', tmdbId: 550, requestedBy: 'Someone' }] }),
            { query: 'some film' }
        );
        expect(d.verdict.stage).toBe('file');
        expect((d.verdict.next_steps ?? []).map(x => x.tool)).not.toContain('respond_to_request');
        expect(d.steps.find(s => s.stage === 'request')?.status).toBe('skipped');
    });

    it('sees a pending request behind an approved one for the same series, as the write checks do', async () => {
        const series: IndexInput = {
            kind: 'series',
            title: '<<untrusted:sonarr.title>>A Series<</>>',
            ids: { tvdb: 700 },
            acquisition: { service: 'sonarr', monitored: true, hasFile: false }
        };
        const adapters = [
            stub('sonarr', { listLibrary: async () => [series] }),
            stub('seerr', {
                getRequests: async () => [
                    { service: 'seerr', id: 1, status: 'approved', mediaType: 'tv', tvdbId: 700, requestedBy: 'Someone' },
                    { service: 'seerr', id: 2, status: 'pending', mediaType: 'tv', tvdbId: 700, requestedBy: 'Someone' }
                ]
            })
        ];
        const d = await buildDiagnose({ adapters, library: new LibraryLoader(adapters, undefined) }, { query: 'a series' });
        expect(d.verdict.stage).toBe('request');
        expect(d.steps.find(s => s.stage === 'request')?.detail).toBe('The request is still awaiting approval.');
    });
});

describe('diagnose by name and a partial match', () => {
    const film = (title: string): IndexInput => ({ ...FILM, title: `<<untrusted:radarr.title>>${title}<</>>`, ids: { tmdb: 77 } });
    const resolve = async (title: string) => {
        const adapters = [stub('radarr', { listLibrary: async () => [film(title)], getQueue: async () => [] }), lidarr()];
        return buildDiagnose({ adapters, library: new LibraryLoader(adapters, undefined) }, { query: 'daft punk' });
    };

    it('keeps an artist whose name is exact over a film that only starts with it', async () => {
        expect((await resolve('Daft Punk Unchained')).resolved?.kind).toBe('artist');
    });

    it('keeps an artist whose name is exact over a film that only contains it', async () => {
        expect((await resolve('The Story of Daft Punk')).resolved?.kind).toBe('artist');
    });

    it('still prefers a film of exactly the same name', async () => {
        expect((await resolve('Daft Punk')).resolved?.kind).toBe('movie');
    });
});

describe('the diagnose budget', () => {
    afterEach(() => {
        vi.useRealTimers();
    });
    it('reports a service that outlasts the budget as unknown, and answers anyway', async () => {
        vi.useFakeTimers();
        const adapters = [
            stub('radarr', { listLibrary: async () => [FILM], getQueue: async () => [] }),
            stub('seerr', { getRequests: () => new Promise(() => {}) })
        ];
        const pending = buildDiagnose({ adapters, library: new LibraryLoader(adapters, undefined) }, { query: 'some film' });
        await vi.advanceTimersByTimeAsync(DIAGNOSE_BUDGET_MS);
        const d = await pending;
        expect(d.degraded).toContain('seerr');
        expect(d.steps.find(s => s.stage === 'request')?.status).toBe('unknown');
        expect(d.verdict.certain).toBe(false);
    });
    it('reports a download client that outlasts the budget as unknown, and answers anyway', async () => {
        vi.useFakeTimers();
        const adapters = [stub('radarr', { listLibrary: async () => [FILM], getQueue: () => new Promise(() => {}) })];
        const pending = buildDiagnose({ adapters, library: new LibraryLoader(adapters, undefined) }, { query: 'some film' });
        await vi.advanceTimersByTimeAsync(DIAGNOSE_BUDGET_MS);
        const d = await pending;
        expect(d.degraded).toContain('radarr');
        expect(d.steps.find(s => s.stage === 'queue')?.status).toBe('unknown');
    });
    it('answers a pending request without the next step when the permission check never settles', async () => {
        vi.useFakeTimers();
        const adapters = [
            stub('radarr', { listLibrary: async () => [FILM], getQueue: async () => [] }),
            stub('seerr', {
                getRequests: async () => [{ service: 'seerr', id: 9, status: 'pending', mediaType: 'movie', tmdbId: 550, requestedBy: 'Someone', requestedById: 3 }]
            })
        ];
        const pending = collectEvidence(
            {
                adapters,
                library: new LibraryLoader(adapters, undefined),
                seerrIdentity: { allowsOtherUsers: false, hasDefaultUser: true, resolve: () => new Promise(() => {}) } as never
            },
            { query: 'some film' }
        );
        await vi.advanceTimersByTimeAsync(DIAGNOSE_BUDGET_MS);
        const evidence = await pending;
        expect(evidence.request).toMatchObject({ status: 'pending', mayRespond: false });
        expect(evidence.degraded).toContain('seerr');
    });
    it('checks whether the caller may retry a failed request', async () => {
        const adapters = [
            stub('radarr', { listLibrary: async () => [FILM], getQueue: async () => [] }),
            stub('seerr', {
                getRequests: async () => [{ service: 'seerr', id: 9, status: 'failed', mediaType: 'movie', tmdbId: 550, requestedBy: 'Someone', requestedById: 3 }]
            })
        ];
        const evidence = await collectEvidence(
            { adapters, library: new LibraryLoader(adapters, undefined), seerrIdentity: { allowsOtherUsers: true } as never },
            { query: 'some film' }
        );
        expect(evidence.request).toMatchObject({ status: 'failed', id: 9, mayRespond: true });
    });
    it('does not start a read once the budget has run out', async () => {
        vi.useFakeTimers();
        let historyReads = 0;
        const adapters = [
            stub('radarr', {
                listLibrary: async () => [{ ...FILM, acquisition: { service: 'radarr', id: '5', monitored: true, hasFile: false } }],
                getQueue: () => new Promise(() => {}),
                readHistory: async () => {
                    historyReads += 1;
                    return { items: [], total: 0 };
                }
            }),
            stub('cleanuparr', { getSeedingRules: async () => [], readHistory: async () => ({ items: [], total: 0 }) })
        ];
        const pending = collectEvidence({ adapters, library: new LibraryLoader(adapters, undefined) }, { query: 'some film' });
        await vi.advanceTimersByTimeAsync(DIAGNOSE_BUDGET_MS);
        const evidence = await pending;
        expect(historyReads).toBe(0);
        expect(evidence.degraded).toContain('radarr:history');
    });
    it('leaves no timer running once it answers', async () => {
        vi.useFakeTimers();
        await buildDiagnose(deps(), { query: 'some film' });
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('findRequest', () => {
    const req = (id: number, status: MediaRequest['status'], requestedAt?: string, over: Partial<MediaRequest> = {}): MediaRequest => ({
        service: 'seerr',
        id,
        status,
        mediaType: 'movie',
        tmdbId: 550,
        requestedBy: 'someone',
        ...(requestedAt === undefined ? {} : { requestedAt }),
        ...over
    });

    it('takes the newest request, whatever order Seerr lists them in', () => {
        const found = findRequest([req(1, 'declined', '2026-01-10T00:00:00Z'), req(2, 'approved', '2026-03-10T00:00:00Z')], { tmdb: 550 }, 'movie');
        expect(found?.id).toBe(2);
    });

    it('still prefers a pending request over a newer one', () => {
        const found = findRequest([req(1, 'pending', '2026-01-10T00:00:00Z'), req(2, 'approved', '2026-03-10T00:00:00Z')], { tmdb: 550 }, 'movie');
        expect(found?.id).toBe(1);
    });

    it('puts an undated request last, and breaks a tie on the TMDB match', () => {
        expect(findRequest([req(1, 'declined'), req(2, 'approved', '2026-03-10T00:00:00Z')], { tmdb: 550 }, 'movie')?.id).toBe(2);
        const byTvdb = req(3, 'declined', '2026-03-10T00:00:00Z', { mediaType: 'tv', tmdbId: 9, tvdbId: 1 });
        const byTmdb = req(4, 'approved', '2026-03-10T00:00:00Z', { mediaType: 'tv' });
        expect(findRequest([byTvdb, byTmdb], { tmdb: 550, tvdb: 1 }, 'series')?.id).toBe(4);
    });
});
