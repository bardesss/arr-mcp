import { describe, expect, it } from 'vitest';
import type { KeyedServiceConfig } from '../src/config/schema.ts';
import { apiKeyHeader } from '../src/core/auth.ts';
import { ServiceHttp } from '../src/core/http.ts';
import { RENAME_MARKER, assertQueueClear, namingFormatKey, renameThroughTemporaryFormat } from '../src/services/arrRename.ts';
import { jsonResponse } from './helpers/serve.ts';

/**
 * The two passes a rotated season needs, and the four things that bound what
 * changing a server-wide setting for the length of them can cost (#264).
 */

const keyed = (): KeyedServiceConfig => ({
    url: 'http://192.0.2.10:8989',
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: true, destructive: false }
});

const FORMAT = '{Series Title} - S{season:00}E{episode:00} - {Episode Title}';

type Opts = {
    /** What `/api/v3/config/naming` starts out holding. */
    naming?: Record<string, unknown>;
    /** Queued or running commands, as `/api/v3/command` reports them. */
    commands?: Record<string, unknown>[];
    /** The count each `RenameFiles` reports, in order. */
    counts?: (number | undefined)[];
    /** Import history as it stands before the window opens. */
    history?: Record<string, unknown>[];
    /** Import history rows that appear once the first rename has been sent. */
    historyDuring?: Record<string, unknown>[];
    /** What `/api/v3/rename` still lists at the end — files Sonarr wants named differently. */
    pending?: Record<string, unknown>[];
    /** Set on the naming config the moment the first rename is sent, as someone editing settings mid-window. */
    editedMidWindow?: Record<string, unknown>;
};

function sonarr(opts: Opts = {}) {
    const naming: Record<string, unknown> = { id: 1, standardEpisodeFormat: FORMAT, animeEpisodeFormat: 'anime', ...opts.naming };
    const formats: string[] = [];
    const renames: { files: number[]; formatAtTheTime: unknown }[] = [];
    let pass = 0;

    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const method = init?.method ?? 'GET';
        const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;

        if (url.pathname === '/api/v3/command' && method === 'GET') return jsonResponse(opts.commands ?? []);
        if (url.pathname === '/api/v3/config/naming' && method === 'GET') return jsonResponse(naming);
        if (url.pathname === '/api/v3/config/naming' && method === 'PUT') {
            Object.assign(naming, body);
            formats.push(String(naming.standardEpisodeFormat));
            return new Response(null, { status: 202 });
        }
        if (url.pathname === '/api/v3/command' && method === 'POST') {
            if (renames.length === 0 && opts.editedMidWindow !== undefined) Object.assign(naming, opts.editedMidWindow);
            renames.push({
                files: (body?.files ?? []) as number[],
                formatAtTheTime: naming.standardEpisodeFormat
            });
            return jsonResponse({ id: 40 + renames.length, name: body?.name, status: 'queued' });
        }
        if (url.pathname.startsWith('/api/v3/command/')) {
            const count = (opts.counts ?? [])[pass];
            const n = count === undefined && opts.counts !== undefined ? undefined : (count ?? 3);
            pass += 1;
            return jsonResponse({
                id: Number(url.pathname.split('/').pop()),
                status: 'completed',
                result: 'successful',
                ...(n === undefined ? {} : { message: `${n} selected episode files renamed for Show` })
            });
        }
        if (url.pathname === '/api/v3/history') {
            return jsonResponse({ records: [...(renames.length > 0 ? (opts.historyDuring ?? []) : []), ...(opts.history ?? [])] });
        }
        if (url.pathname === '/api/v3/rename') return jsonResponse(opts.pending ?? []);
        return jsonResponse({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;

    return {
        http: new ServiceHttp('sonarr', keyed(), apiKeyHeader('X-Api-Key', 'k'), impl),
        naming,
        formats,
        renames
    };
}

describe('namingFormatKey', () => {
    /** Changing the standard format for an anime series changes a format
     *  nothing in it is named by: the pass renames nothing and the setting
     *  moved for no reason. */
    it('follows the series type, because Sonarr keeps three formats', () => {
        expect(namingFormatKey('standard')).toBe('standardEpisodeFormat');
        expect(namingFormatKey('anime')).toBe('animeEpisodeFormat');
        expect(namingFormatKey('daily')).toBe('dailyEpisodeFormat');
        expect(namingFormatKey(undefined)).toBe('standardEpisodeFormat');
    });
});

describe('assertQueueClear', () => {
    /** Both run every minute, so waiting for an empty queue would mean never
     *  starting. What they can do to the window is reported afterwards. */
    it('ignores the per-minute housekeeping that is always there', async () => {
        const s = sonarr({
            commands: [
                { id: 1, name: 'RefreshMonitoredDownloads', status: 'started' },
                { id: 2, name: 'ProcessMonitoredDownloads', status: 'queued' }
            ]
        });
        await expect(assertQueueClear(s.http, 'sonarr')).resolves.toBeUndefined();
    });

    /** The window is one command's turn in the queue, not a fixed few seconds:
     *  behind a refresh on a large library it is minutes with the temporary
     *  format live throughout. */
    it('refuses behind real work, and names what it is waiting on', async () => {
        const s = sonarr({ commands: [{ id: 3, name: 'RefreshSeries', status: 'started' }] });
        await expect(assertQueueClear(s.http, 'sonarr')).rejects.toThrow(/RefreshSeries/);
        await expect(assertQueueClear(s.http, 'sonarr')).rejects.toThrow(/already applied and correct/);
    });
});

describe('renameThroughTemporaryFormat', () => {
    it('renames under a marked format, then under the real one', async () => {
        const s = sonarr();
        const out = await renameThroughTemporaryFormat(s.http, 'sonarr', 5, 'standard', [11, 12, 13]);

        // Two passes over the same files: the first frees every destination,
        // the second lands on it.
        expect(s.renames.map(r => r.files)).toEqual([
            [11, 12, 13],
            [11, 12, 13]
        ]);
        expect(s.renames[0]?.formatAtTheTime).toBe(`${FORMAT}${RENAME_MARKER}`);
        expect(s.renames[1]?.formatAtTheTime).toBe(FORMAT);
        expect(out.renamed).toBe(3);
    });

    it('leaves the naming format exactly as it found it', async () => {
        const s = sonarr();
        await renameThroughTemporaryFormat(s.http, 'sonarr', 5, 'standard', [11, 12, 13]);
        expect(s.naming.standardEpisodeFormat).toBe(FORMAT);
    });

    /** A `finally` does not run when the process is killed, so the format can
     *  be found still marked on the next call. The marker is a suffix, so the
     *  original is recoverable from the live value alone — nothing has to be
     *  written down anywhere. */
    it('recovers a format left marked by an interrupted run', async () => {
        const s = sonarr({ naming: { standardEpisodeFormat: `${FORMAT}${RENAME_MARKER}` } });
        await renameThroughTemporaryFormat(s.http, 'sonarr', 5, 'standard', [11]);
        expect(s.naming.standardEpisodeFormat).toBe(FORMAT);
    });

    it('puts the format back even when the first pass fails', async () => {
        const s = sonarr({ counts: [0, 0] });
        await expect(renameThroughTemporaryFormat(s.http, 'sonarr', 5, 'standard', [11, 12, 13])).rejects.toThrow(
            /only 0 of 3/
        );
        expect(s.naming.standardEpisodeFormat).toBe(FORMAT);
    });

    /** Leaving a file under the temporary name is the worst outcome here, so
     *  it is reported as an error naming the marker rather than as a success. */
    it('refuses to report success when the second pass leaves a file marked', async () => {
        const s = sonarr({ counts: [3, 1], pending: [{ episodeFileId: 12 }, { episodeFileId: 13 }] });
        await expect(renameThroughTemporaryFormat(s.http, 'sonarr', 5, 'standard', [11, 12, 13])).rejects.toThrow(
            /2 file\(s\) under a temporary name/
        );
    });

    /** A build that stops sending the count reports undefined twice, which
     *  would otherwise read as every file renamed having renamed none. */
    it('does not take two silent commands for success when Sonarr still wants a rename', async () => {
        const s = sonarr({ counts: [undefined, undefined], pending: [{ episodeFileId: 11 }] });
        await expect(renameThroughTemporaryFormat(s.http, 'sonarr', 5, 'standard', [11, 12])).rejects.toThrow(
            /1 file\(s\) under a temporary name/
        );
    });

    /** The PUT takes the whole config, so restoring from a snapshot taken
     *  before the window would revert anything else edited during it. */
    it('puts back only the format it changed', async () => {
        const s = sonarr({ editedMidWindow: { renameEpisodes: false } });
        await renameThroughTemporaryFormat(s.http, 'sonarr', 5, 'standard', [11]);
        expect(s.naming.renameEpisodes).toBe(false);
        expect(s.naming.standardEpisodeFormat).toBe(FORMAT);
    });

    /**
     * The one cost that cannot be prevented: the per-minute import is excluded
     * from the queue check, so a file can land inside the window and be named
     * by the temporary format.
     */
    it('reports what Sonarr imported while the format was marked', async () => {
        const s = sonarr({
            history: [{ id: 7, data: { importedPath: '/tv/Other/old.mkv' } }],
            historyDuring: [
                { id: 8, data: { importedPath: `/tv/Other/new${RENAME_MARKER}.mkv` } },
                // Another series type's format was live, not the one changed.
                { id: 9, data: { importedPath: '/tv/Anime/other.mkv' } }
            ]
        });
        const out = await renameThroughTemporaryFormat(s.http, 'sonarr', 5, 'standard', [11]);

        expect(out.caughtInWindow).toHaveLength(1);
        expect(out.caughtInWindow[0]).toContain('/tv/Other/new');
    });

    /** The renames are done by the time history is read, so failing to read it
     *  is not a reason to report the rename as failed. */
    it('still reports the rename when history cannot be read', async () => {
        const s = sonarr();
        const out = await renameThroughTemporaryFormat(s.http, 'sonarr', 5, 'standard', [11]);
        expect(out.renamed).toBe(1);
        expect(out.caughtInWindow).toEqual([]);
    });
});
