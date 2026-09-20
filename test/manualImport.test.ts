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

/**
 * What `/api/v3/rename?seriesId=` reports after the rotation has been applied:
 * every file's wanted name is the name another file in the same set is still
 * using. Series-relative, the shape a live Sonarr returns (#264).
 */
const PENDING_RENAMES = [
    { episodeFileId: 11, existingPath: 'Season 01/Show - S01E01.mkv', newPath: 'Season 01/Show - S01E02.mkv' },
    { episodeFileId: 12, existingPath: 'Season 01/Show - S01E02.mkv', newPath: 'Season 01/Show - S01E03.mkv' },
    { episodeFileId: 13, existingPath: 'Season 01/Show - S01E03.mkv', newPath: 'Season 01/Show - S01E01.mkv' }
];

/**
 * A Sonarr that applies what it is told: the `ManualImport` command moves each
 * path onto the episode ids it was given, and `/api/v3/episode` answers with
 * the association that results. Modelled rather than stubbed flat, because the
 * remap now checks that what it asked for is what landed — a stub that always
 * replays the old association would fail that check for the right reason and
 * prove nothing (#264).
 *
 * `halfApplies` is the failure seen live: Sonarr reports the command
 * `completed` and `successful` while one file never moves.
 */
function seriesStack(
    opts: { renames?: unknown[]; message?: string; omitMessage?: boolean; halfApplies?: boolean } = {}
) {
    const sent: { path: string; method: string; body: Record<string, unknown> | undefined }[] = [];
    let lastCommand = 'ManualImport';
    const episodes = EPISODES.map(e => ({ ...e }));

    const apply = (files: { path?: string; episodeIds?: number[] }[]) => {
        const fileIdOf = (path: string) => SERIES_FILES.find(f => f.path === path)?.episodeFileId;
        const moves = opts.halfApplies === true ? files.slice(0, -1) : files;
        for (const f of moves) {
            const fileId = fileIdOf(f.path ?? '');
            for (const id of f.episodeIds ?? []) {
                const episode = episodes.find(e => e.id === id);
                if (episode !== undefined && fileId !== undefined) episode.episodeFileId = fileId;
            }
        }
    };

    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const method = init?.method ?? 'GET';
        const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
        sent.push({ path: url.pathname + url.search, method, body });

        if (url.pathname === '/api/v3/manualimport') return jsonResponse(SERIES_FILES);
        if (url.pathname === '/api/v3/episode') return jsonResponse(episodes);
        if (url.pathname === '/api/v3/rename') return jsonResponse(opts.renames ?? []);
        if (url.pathname === '/api/v3/command' && method === 'POST') {
            lastCommand = String(body?.name ?? 'ManualImport');
            if (lastCommand === 'ManualImport') {
                apply((body?.files ?? []) as { path?: string; episodeIds?: number[] }[]);
            }
            return jsonResponse({ id: 92, name: lastCommand, status: 'queued' });
        }
        // Settles immediately — the wait itself is covered in
        // test/arrCommands.test.ts rather than re-asserted per caller.
        if (url.pathname === '/api/v3/command/92') {
            return jsonResponse({
                id: 92,
                name: lastCommand,
                status: 'completed',
                result: 'successful',
                ...(lastCommand === 'RenameFiles' && opts.omitMessage !== true
                    ? { message: opts.message ?? '1 selected episode files renamed for Show' }
                    : {})
            });
        }
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
    /** Reported on #275: `rotation` drives what the preview promises, so it has
     *  to describe the moves that will be sent, and only a true cycle is a
     *  deadlock. */
    describe('predicting which renames can go through', () => {
        const plan = async (reassignments: { path: string; season: number; episode: number }[]) => {
            const { rotation, chain, moves } = await seriesStack().sonarr.planEpisodeRemap('5', reassignments);
            return { rotation, chain, moves: moves.length };
        };

        it('is not a rotation when the only held target belongs to a file already in place', async () => {
            expect(
                await plan([
                    { path: 'Season 01/Show - S01E01.mkv', season: 1, episode: 1 },
                    { path: 'Season 01/Show - S01E03.mkv', season: 1, episode: 4 }
                ])
            ).toEqual({ rotation: false, chain: false, moves: 1 });
        });

        it('calls a chain a chain: the tail renames and another pass finishes the head', async () => {
            expect(
                await plan([
                    { path: 'Season 01/Show - S01E01.mkv', season: 1, episode: 2 },
                    { path: 'Season 01/Show - S01E02.mkv', season: 1, episode: 4 }
                ])
            ).toEqual({ rotation: false, chain: true, moves: 2 });
        });

        it('calls a true cycle a rotation', async () => {
            expect(await plan(ROTATION)).toEqual({ rotation: true, chain: false, moves: 3 });
        });
    });

    it('applies the whole rotation as one command, with the episodes the caller gave', async () => {
        const s = seriesStack();
        await s.sonarr.runEpisodeRemap('5', ROTATION);

        const posts = s.sent.filter(x => x.method === 'POST');
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

        const command = s.sent.find(x => x.method === 'POST' && (x.body as { name?: string })?.name === 'ManualImport')
            ?.body as { files: { path: string }[] };
        expect(command.files.map(f => f.path)).not.toContain('/tv/Show/Season 01/Show - S01E03.mkv');
        expect(command.files).toHaveLength(2);
    });

    /**
     * The rename is part of the remap: it needs the ids Sonarr assigns while
     * reassigning, and `RenameSeries` — what `action: "rename"` sends — would
     * rename the whole series instead of the files that moved (#264).
     */
    it('renames only the files it moved, by the ids Sonarr assigned', async () => {
        const s = seriesStack({
            renames: [
                { episodeFileId: 11, existingPath: 'Season 01/Show - S01E01.mkv', newPath: 'Season 01/Show - S01E09.mkv' }
            ],
            message: '1 selected episode files renamed for Show'
        });
        const out = await s.sonarr.runEpisodeRemap('5', ROTATION);

        const rename = s.sent.find(x => x.method === 'POST' && (x.body as { name?: string })?.name === 'RenameFiles');
        expect(rename?.body).toMatchObject({ seriesId: 5, files: [11] });
        expect(out.renamed).toBe(1);
        expect(out.blocked).toEqual([]);
    });

    /**
     * The rotation from the issue: every new name is another moved file's
     * current name, so nothing has a free destination. Sonarr would answer
     * `completed` and rename nothing, so this does not ask it to.
     */
    it('sends no rename when every destination is still on disk, and says which files wait', async () => {
        const s = seriesStack({ renames: PENDING_RENAMES });
        const out = await s.sonarr.runEpisodeRemap('5', ROTATION);

        expect(s.sent.filter(x => (x.body as { name?: string })?.name === 'RenameFiles')).toHaveLength(0);
        expect(out.renamed).toBe(0);
        expect(out.blocked).toHaveLength(3);
        // Both paths come from Sonarr, so both are fenced before a model
        // reads them — the same treatment `display` already gets.
        expect(out.blocked[0]?.path).toContain('Season 01/Show - S01E01.mkv');
        expect(out.blocked[0]?.wants).toContain('Season 01/Show - S01E02.mkv');
        expect(out.blocked[0]?.path).toMatch(/untrusted/);
    });

    /**
     * `completed` is not the signal. A blocked rename reports exactly that
     * status with a count of zero, so the count is what decides.
     */
    it('refuses to report success when Sonarr renamed fewer files than it was given', async () => {
        const s = seriesStack({
            renames: [
                { episodeFileId: 11, existingPath: 'Season 01/Show - S01E01.mkv', newPath: 'Season 01/Show - S01E09.mkv' },
                { episodeFileId: 12, existingPath: 'Season 01/Show - S01E02.mkv', newPath: 'Season 01/Show - S01E08.mkv' }
            ],
            message: '0 selected episode files renamed for Show'
        });

        await expect(s.sonarr.runEpisodeRemap('5', ROTATION)).rejects.toThrow(/renamed only 0 of 2/);
    });

    /** A build that stops sending the message is not a build that renamed
     *  nothing — the two must not read the same. Sonarr accepted the command
     *  and reported no fault, so the files it was given count as renamed. */
    it('does not read a missing message as nothing renamed', async () => {
        const s = seriesStack({
            renames: [
                { episodeFileId: 11, existingPath: 'Season 01/Show - S01E01.mkv', newPath: 'Season 01/Show - S01E09.mkv' }
            ],
            omitMessage: true
        });
        const out = await s.sonarr.runEpisodeRemap('5', ROTATION);
        expect(out.renamed).toBe(1);
    });

    /**
     * Found on a live Sonarr 4.0.19, not imagined: a rotation sent seconds
     * after two earlier remaps of the same series left one episode pointing at
     * a duplicate row for another file's path, while the file that should have
     * moved there ended up attached to nothing. Every command in that sequence
     * reported `completed` and `successful`.
     */
    it('fails when Sonarr reports success but a file did not land on its episode', async () => {
        const s = seriesStack({ halfApplies: true });
        await expect(s.sonarr.runEpisodeRemap('5', ROTATION)).rejects.toThrow(/did not land on the episode asked for/);
    });

    it('does not rename anything when the reassignment did not land', async () => {
        const s = seriesStack({ halfApplies: true });
        await expect(s.sonarr.runEpisodeRemap('5', ROTATION)).rejects.toThrow();
        expect(s.sent.filter(x => (x.body as { name?: string })?.name === 'RenameFiles')).toHaveLength(0);
    });

    /** Nothing is lost when it happens, so the refusal has to say so — and
     *  say which episode is wrong, because that is what a repair needs. */
    it('says what is still on disk and which episode is wrong', async () => {
        const s = seriesStack({ halfApplies: true });
        await expect(s.sonarr.runEpisodeRemap('5', ROTATION)).rejects.toThrow(/still on disk/);
        await expect(s.sonarr.runEpisodeRemap('5', ROTATION)).rejects.toThrow(/S01E03 should hold/);
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
