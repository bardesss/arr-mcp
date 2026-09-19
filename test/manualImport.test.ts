import { describe, expect, it } from 'vitest';
import type { KeyedServiceConfig } from '../src/config/schema.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import { SonarrAdapter } from '../src/services/sonarr.ts';
import { jsonResponse } from './helpers/serve.ts';

/**
 * "It is in SABnzbd and Jellyfin still cannot see it" — the download finished
 * and the *arr never took it. A library scan does not help: the file is still
 * in the client's folder.
 */
const keyed = (port: number): KeyedServiceConfig => ({
    url: `http://192.0.2.10:${port}`,
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
});

const CANDIDATES = [
    {
        path: '/downloads/Heat.1995.mkv',
        relativePath: 'Heat.1995.mkv',
        size: 8_000_000_000,
        movie: { id: 15, title: 'Heat' },
        quality: { quality: { id: 7, name: 'Bluray-1080p' } },
        languages: [{ id: 1, name: 'English' }],
        releaseGroup: 'GROUP',
        rejections: []
    },
    {
        path: '/downloads/sample.mkv',
        relativePath: 'sample.mkv',
        size: 2_000_000,
        rejections: [{ reason: 'Unknown movie' }]
    }
];

function stack(candidates: unknown = CANDIDATES, queue: unknown[] = []) {
    const sent: { path: string; search: string; method: string; body: Record<string, unknown> | undefined }[] = [];

    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const method = init?.method ?? 'GET';
        sent.push({
            path: url.pathname,
            search: url.search,
            method,
            body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
        });

        if (url.pathname === '/api/v3/manualimport') {
            // A number stands for the status the service answers with, which is
            // how the 500 cases below are written.
            return typeof candidates === 'number'
                ? jsonResponse({ message: 'Object reference not set to an instance of an object.' }, candidates)
                : jsonResponse(candidates);
        }
        if (url.pathname === '/api/v3/queue') return jsonResponse({ records: queue, totalRecords: queue.length });
        if (url.pathname === '/api/v3/command') return jsonResponse({ id: 91, name: 'ManualImport', status: 'queued' });
        return jsonResponse({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;

    return { impl, sent };
}

/**
 * Radarr and Sonarr answer HTTP 500 for a download that has not finished — see
 * the note on `explainUnfinishedDownload`. These rows are what `/queue` says
 * about such a download, taken from a live Radarr 6.3.0.10514.
 */
const RUNNING_ROW = {
    id: 1,
    title: 'Heat.1995.mkv',
    downloadId: 'nzo_abc',
    status: 'queued',
    trackedDownloadState: 'downloading',
    movieId: 15
};

describe('manual import candidates', () => {
    it('reports what the service matched and what it will not take', async () => {
        const rows = await new RadarrAdapter(keyed(7878), stack().impl).listImportCandidates('nzo_abc');

        expect(rows).toHaveLength(2);
        expect(rows[0]?.matchedTitle).toContain('Heat');
        expect(rows[0]?.rejections).toEqual([]);
        expect(rows[1]?.rejections.join(' ')).toContain('Unknown movie');
    });

    it('fences the rejection reason and the file name, which are upstream text', async () => {
        const rows = await new RadarrAdapter(keyed(7878), stack().impl).listImportCandidates('nzo_abc');
        expect(rows[1]?.rejections[0]).toMatch(/untrusted/);
        expect(rows[0]?.display).toMatch(/untrusted/);
    });

    it('asks by download id', async () => {
        const s = stack();
        await new RadarrAdapter(keyed(7878), s.impl).listImportCandidates('nzo_abc');
        expect(s.sent[0]?.search).toContain('downloadId=nzo_abc');
    });
});

describe('running a manual import', () => {
    it('imports only the files the service is willing to take', async () => {
        const s = stack();
        await new RadarrAdapter(keyed(7878), s.impl).runManualImport('nzo_abc');

        const command = s.sent.find(x => x.method === 'POST')?.body as {
            name: string;
            importMode: string;
            files: { path: string; movieId: number; quality: unknown }[];
        };
        expect(command.name).toBe('ManualImport');
        expect(command.importMode).toBe('auto');
        expect(command.files).toHaveLength(1);
        expect(command.files[0]).toMatchObject({ path: '/downloads/Heat.1995.mkv', movieId: 15 });
    });

    it('echoes the quality the service reported rather than inventing one', async () => {
        const s = stack();
        await new RadarrAdapter(keyed(7878), s.impl).runManualImport('nzo_abc');
        const files = (s.sent.find(x => x.method === 'POST')?.body as { files: { quality: unknown }[] }).files;
        expect(files[0]?.quality).toEqual({ quality: { id: 7, name: 'Bluray-1080p' } });
    });

    it('posts the raw path, never the fenced display form', async () => {
        const s = stack();
        await new RadarrAdapter(keyed(7878), s.impl).runManualImport('nzo_abc');
        expect(JSON.stringify(s.sent.find(x => x.method === 'POST')?.body)).not.toContain('untrusted');
    });

    it('refuses when every file is rejected, naming the reasons', async () => {
        const s = stack([CANDIDATES[1]]);
        await expect(new RadarrAdapter(keyed(7878), s.impl).runManualImport('nzo_bad')).rejects.toThrow(
            /Unknown movie/
        );
        expect(s.sent.some(x => x.method === 'POST')).toBe(false);
    });

    it('refuses when the service knows nothing about that download id', async () => {
        const s = stack([]);
        await expect(new RadarrAdapter(keyed(7878), s.impl).runManualImport('gone')).rejects.toThrow(/get_queue/);
    });

    it('sends the episode ids Sonarr placed the file in', async () => {
        const s = stack([
            {
                path: '/downloads/Taboo.S01E01.mkv',
                relativePath: 'Taboo.S01E01.mkv',
                series: { id: 7, title: 'Taboo' },
                seasonNumber: 1,
                episodes: [{ id: 101 }],
                quality: { quality: { id: 4 } },
                rejections: []
            }
        ]);
        await new SonarrAdapter(keyed(8989), s.impl).runManualImport('nzo_taboo');

        const files = (s.sent.find(x => x.method === 'POST')?.body as { files: Record<string, unknown>[] }).files;
        expect(files[0]).toMatchObject({ seriesId: 7, seasonNumber: 1, episodeIds: [101] });
    });

    /** `ManualImport` with no episode ids is accepted and imports nothing. */
    it('treats a Sonarr file matched to no episode as not importable', async () => {
        const s = stack([
            { path: '/downloads/x.mkv', series: { id: 7, title: 'Taboo' }, episodes: [], rejections: [] }
        ]);
        await expect(new SonarrAdapter(keyed(8989), s.impl).runManualImport('nzo_x')).rejects.toThrow(
            /no episode matched/
        );
    });
});

/**
 * The live integration run caught this: previewing an import for a download
 * that is still running answers HTTP 500, because both services dereference a
 * null `ImportItem`. `UpstreamError: HTTP 500 at /api/v3/manualimport` tells a
 * model nothing it can act on; "it has not finished downloading" does.
 */
describe('a download that has not finished', () => {
    it('says so, rather than reporting a bare upstream error', async () => {
        const s = stack(500, [RUNNING_ROW]);
        await expect(new RadarrAdapter(keyed(7878), s.impl).listImportCandidates('nzo_abc')).rejects.toThrow(
            /has not finished downloading/
        );
    });

    it('names the state get_queue reports, so the model can say what to wait for', async () => {
        const s = stack(500, [RUNNING_ROW]);
        await expect(new RadarrAdapter(keyed(7878), s.impl).runManualImport('nzo_abc')).rejects.toThrow(
            /queued\/downloading/
        );
        expect(s.sent.some(x => x.method === 'POST')).toBe(false);
    });

    it('explains Sonarr the same way — its copy of the method has the same hole', async () => {
        const s = stack(500, [{ ...RUNNING_ROW, movieId: undefined, seriesId: 7 }]);
        await expect(new SonarrAdapter(keyed(8989), s.impl).listImportCandidates('nzo_abc')).rejects.toThrow(
            /has not finished downloading/
        );
    });

    it('matches the queue row whatever case the download id was given in', async () => {
        const s = stack(500, [{ ...RUNNING_ROW, downloadId: 'ABC123' }]);
        await expect(new RadarrAdapter(keyed(7878), s.impl).listImportCandidates('abc123')).rejects.toThrow(
            /has not finished downloading/
        );
    });

    /**
     * The guard that keeps this from becoming a catch-all: a 500 on a download
     * the client has finished is a real fault, and calling it "still
     * downloading" would send someone looking in the wrong place.
     */
    it('leaves a 500 on a completed download as the upstream error it is', async () => {
        const s = stack(500, [{ ...RUNNING_ROW, status: 'completed', trackedDownloadState: 'importBlocked' }]);
        await expect(new RadarrAdapter(keyed(7878), s.impl).listImportCandidates('nzo_abc')).rejects.toThrow(
            /HTTP 500/
        );
    });

    it('leaves a 500 the queue says nothing about alone', async () => {
        const s = stack(500, []);
        await expect(new RadarrAdapter(keyed(7878), s.impl).listImportCandidates('nzo_abc')).rejects.toThrow(
            /HTTP 500/
        );
    });

    /** An unknown id is a 200 and an empty list upstream, not a 500. */
    it('still refuses an unknown download id on its own terms', async () => {
        const s = stack([], [RUNNING_ROW]);
        await expect(new RadarrAdapter(keyed(7878), s.impl).runManualImport('nzo_abc')).rejects.toThrow(/get_queue/);
    });
});

/**
 * The mislabel every signal agrees with: the file named E03 is the Pilot, and
 * each other file is one episode late. Sonarr's `/manualimport?seriesId=`
 * reports the association it already has, which is what these rows are.
 */
const EPISODES = [
    { id: 101, seasonNumber: 1, episodeNumber: 1, episodeFileId: 11 },
    { id: 102, seasonNumber: 1, episodeNumber: 2, episodeFileId: 12 },
    { id: 103, seasonNumber: 1, episodeNumber: 3, episodeFileId: 13 },
    { id: 104, seasonNumber: 1, episodeNumber: 4, episodeFileId: 0 }
];
const SERIES_FILES = [1, 2, 3].map(n => ({
    path: `/tv/Show/Season 01/Show - S01E0${n}.mkv`,
    relativePath: `Season 01/Show - S01E0${n}.mkv`,
    episodeFileId: 10 + n,
    series: { id: 5, title: 'Show' },
    seasonNumber: 1,
    episodes: [{ id: 100 + n }],
    quality: { quality: { id: 7, name: 'Bluray-1080p' } },
    languages: [{ id: 1, name: 'English' }],
    releaseGroup: 'GROUP',
    rejections: []
}));

function seriesStack() {
    const sent: { path: string; method: string; body: Record<string, unknown> | undefined }[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const method = init?.method ?? 'GET';
        sent.push({
            path: url.pathname + url.search,
            method,
            body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
        });
        if (url.pathname === '/api/v3/manualimport') return jsonResponse(SERIES_FILES);
        if (url.pathname === '/api/v3/episode') return jsonResponse(EPISODES);
        if (url.pathname === '/api/v3/command') return jsonResponse({ id: 92, name: 'ManualImport', status: 'queued' });
        return jsonResponse({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;
    return { sonarr: new SonarrAdapter(keyed(8989), impl), sent };
}

const ROTATION = [
    { path: 'Season 01/Show - S01E03.mkv', season: 1, episode: 1 },
    { path: 'Season 01/Show - S01E01.mkv', season: 1, episode: 2 },
    { path: '/tv/Show/Season 01/Show - S01E02.mkv', season: 1, episode: 3 }
];

describe('remapping episodes', () => {
    it('applies the whole rotation as one command, with the episodes the caller gave', async () => {
        const s = seriesStack();
        await s.sonarr.runEpisodeRemap('5', ROTATION);

        const posts = s.sent.filter(x => x.method === 'POST');
        expect(posts).toHaveLength(1);
        const command = posts[0]?.body as { name: string; importMode?: string; files: Record<string, unknown>[] };
        expect(command.name).toBe('ManualImport');
        expect(command.importMode).toBeUndefined();
        expect(command.files).toEqual([
            expect.objectContaining({ path: '/tv/Show/Season 01/Show - S01E03.mkv', seriesId: 5, episodeIds: [101] }),
            expect.objectContaining({ path: '/tv/Show/Season 01/Show - S01E01.mkv', episodeIds: [102] }),
            expect.objectContaining({ path: '/tv/Show/Season 01/Show - S01E02.mkv', episodeIds: [103] })
        ]);
        expect(command.files[0]).toMatchObject({ quality: SERIES_FILES[0]?.quality, releaseGroup: 'GROUP' });
        expect(command.files[0]).not.toHaveProperty('downloadId');
    });

    it('reads the association Sonarr has, not a folder to parse', async () => {
        const s = seriesStack();
        await s.sonarr.planEpisodeRemap('5', ROTATION);
        expect(s.sent.map(x => x.path)).toContain('/api/v3/manualimport?seriesId=5');
    });

    /** The half-applied rotation from #264: the displaced file becomes a row
     *  no episode points at. */
    it('refuses a move that would orphan the file already on the target, and sends nothing', async () => {
        const s = seriesStack();
        await expect(s.sonarr.runEpisodeRemap('5', [ROTATION[0]!])).rejects.toThrow(/S01E01.*not in reassignments/);
        expect(s.sent.filter(x => x.method === 'POST')).toHaveLength(0);
    });

    it('leaves out files already on the episode asked for', async () => {
        const s = seriesStack();
        await s.sonarr.runEpisodeRemap('5', [
            { path: 'Season 01/Show - S01E01.mkv', season: 1, episode: 2 },
            { path: 'Season 01/Show - S01E02.mkv', season: 1, episode: 1 },
            { path: 'Season 01/Show - S01E03.mkv', season: 1, episode: 3 }
        ]);

        const command = s.sent.find(x => x.method === 'POST')?.body as { files: { path: string }[] };
        expect(command.files.map(f => f.path)).not.toContain('/tv/Show/Season 01/Show - S01E03.mkv');
        expect(command.files).toHaveLength(2);
    });

    it('names the episode a move leaves without a file', async () => {
        const s = seriesStack();
        const plan = await s.sonarr.planEpisodeRemap('5', [{ path: 'Season 01/Show - S01E03.mkv', season: 1, episode: 4 }]);
        expect(plan.moves[0]).toMatchObject({ from: 'S01E03', to: 'S01E04' });
        expect(plan.emptied).toEqual(['S01E03']);
    });

    it('refuses a path Sonarr has not imported, an episode it does not have, and two files on one episode', async () => {
        const s = seriesStack();
        await expect(s.sonarr.planEpisodeRemap('5', [{ path: 'nope.mkv', season: 1, episode: 1 }])).rejects.toThrow(
            /no imported file/
        );
        await expect(
            s.sonarr.planEpisodeRemap('5', [{ path: 'Season 01/Show - S01E01.mkv', season: 9, episode: 1 }])
        ).rejects.toThrow(/no episode S09E01/);
        await expect(
            s.sonarr.planEpisodeRemap('5', [
                { path: 'Season 01/Show - S01E01.mkv', season: 1, episode: 4 },
                { path: 'Season 01/Show - S01E02.mkv', season: 1, episode: 4 }
            ])
        ).rejects.toThrow(/one file per episode/);
    });
});
