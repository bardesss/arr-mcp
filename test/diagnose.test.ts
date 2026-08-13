import { describe, expect, it } from 'vitest';
import { ServiceError } from '../src/core/errors.ts';
import { IdentityResolver } from '../src/core/identity.ts';
import type { IndexInput } from '../src/core/resolver.ts';
import { collectEvidence } from '../src/tools/diagnose/evidence.ts';
import { buildDiagnose, type DiagnoseDeps } from '../src/tools/diagnose/index.ts';
import { LibraryLoader } from '../src/tools/library.ts';
import type { ServiceAdapter, UserDirectoryCapable } from '../src/services/types.ts';

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

const FILM: IndexInput = {
    kind: 'movie',
    title: '<<untrusted:radarr.title>>Some Film<</untrusted>>',
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
        expect(d.steps).toHaveLength(8);
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

    it('names the parameters when given neither', async () => {
        await expect(buildDiagnose(deps(), {})).rejects.toThrow(/query.*service.*id/i);
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

    it('Finding F: diagnoses a Jellyfin item as the series Sonarr already manages, not a fabricated unmanaged movie', async () => {
        // JellyfinAdapter.getMediaDetails reports kind: 'item' for everything.
        // Coercing that to 'movie' before calling find() used to restrict the
        // lookup to the movie keyspace and silently miss this series, which
        // is genuinely sitting in the index under sonarr's acquisition.
        const SERIES: IndexInput = {
            kind: 'series',
            title: '<<untrusted:sonarr.title>>A Series<</untrusted>>',
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
            title: '<<untrusted:sonarr.title>>A Series<</untrusted>>',
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
            detail: 'No request recorded — not everything arrives through Seerr.'
        });
        expect(d.verdict.certain).toBe(true);
    });

    it('matches a Seerr request on tvdb id alone, closing the gap Finding B documented', async () => {
        // The other half of the repair: a pending request keyed only by
        // tvdbId (as every Sonarr series request is, absent a tmdb id) must
        // actually be found, not just correctly reported absent.
        const SERIES_NO_TMDB: IndexInput = {
            kind: 'series',
            title: '<<untrusted:sonarr.title>>A Series<</untrusted>>',
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
        expect(evidence.jellyfinConfigured).toBe(false);
        expect(evidence.queue).toBeUndefined();
        expect(evidence.rejections).toBeUndefined();
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
            title: '<<untrusted:radarr.title>>Some Film<</untrusted>>',
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
        expect(d.verdict.remedy).toMatch(/jellyfin library scan/i);
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
            title: '<<untrusted:sonarr.title>>A Series<</untrusted>>',
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
});
