import { describe, expect, it } from 'vitest';
import { ServiceError } from '../src/core/errors.ts';
import type { IndexInput } from '../src/core/resolver.ts';
import { buildDiagnose, type DiagnoseDeps } from '../src/tools/diagnose/index.ts';
import { LibraryLoader } from '../src/tools/library.ts';
import type { ServiceAdapter } from '../src/services/types.ts';

const stub = (id: string, extra: Record<string, unknown>): ServiceAdapter =>
    ({
        id,
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
});
