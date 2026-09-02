import { describe, expect, it } from 'vitest';
import type { KeyedServiceConfig } from '../src/config/schema.ts';
import { BazarrAdapter, bazarrTimestamp } from '../src/services/bazarr.ts';
import { jsonResponse } from './helpers/serve.ts';

/**
 * `get_subtitles` lists what is still missing; this is the other half — what
 * Bazarr actually downloaded, and from which provider.
 */
const config: KeyedServiceConfig = {
    url: 'http://192.0.2.10:6767',
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
};

const serving = (movies: unknown, episodes: unknown = { data: [] }) =>
    (async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        return jsonResponse(url.pathname.startsWith('/api/movies') ? movies : episodes);
    }) as unknown as typeof fetch;

describe('bazarrTimestamp', () => {
    it('reads epoch seconds when that is what the build sends', () => {
        expect(bazarrTimestamp({ timestamp: 1_788_000_000 })).toBe(new Date(1_788_000_000_000).toISOString());
    });

    it('reads the MM/DD/YY form Bazarr formats for its own UI', () => {
        expect(bazarrTimestamp({ parsed_timestamp: '09/02/26 20:07:53' })).toBe('2026-09-02T20:07:53.000Z');
    });

    /** "2 days ago" is what `timestamp` holds on the versions seen. Dating a
     *  row from it would reorder a list sorted as plain strings. */
    it('returns nothing for a relative timestamp rather than guessing', () => {
        expect(bazarrTimestamp({ timestamp: '2 days ago' })).toBeUndefined();
        expect(bazarrTimestamp({})).toBeUndefined();
    });
});

describe('Bazarr history', () => {
    const ROWS = {
        data: [
            {
                id: 1,
                action: 1,
                title: 'Heat',
                description: 'Downloaded from OpenSubtitles',
                language: 'Dutch',
                provider: 'opensubtitles',
                parsed_timestamp: '09/02/26 20:07:53'
            }
        ]
    };

    it('reports a subtitle download as its own event, not as an import', async () => {
        const rows = await new BazarrAdapter(config, serving(ROWS)).readHistory({});
        expect(rows).toHaveLength(1);
        expect(rows[0]?.event).toBe('subtitle');
        expect(rows[0]?.at).toBe('2026-09-02T20:07:53.000Z');
    });

    it('carries the language and provider, and fences both', async () => {
        const rows = await new BazarrAdapter(config, serving(ROWS)).readHistory({});
        expect(rows[0]?.quality).toContain('Dutch');
        expect(rows[0]?.quality).toContain('opensubtitles');
        expect(rows[0]?.quality).toMatch(/untrusted/);
    });

    it('merges the film and episode endpoints into one list', async () => {
        const rows = await new BazarrAdapter(
            config,
            serving(ROWS, { data: [{ id: 2, title: 'Taboo', parsed_timestamp: '09/01/26 10:00:00' }] })
        ).readHistory({});
        expect(rows.map(r => r.id)).toEqual(['1', '2']);
    });

    it('drops a row it cannot date rather than inventing one', async () => {
        const rows = await new BazarrAdapter(
            config,
            serving({ data: [{ id: 3, title: 'No date', timestamp: '2 days ago' }] })
        ).readHistory({});
        expect(rows).toEqual([]);
    });

    it('honours since', async () => {
        const rows = await new BazarrAdapter(config, serving(ROWS)).readHistory({ since: '2026-09-03' });
        expect(rows).toEqual([]);
    });

    it('refuses a per-item id rather than answering empty', async () => {
        await expect(new BazarrAdapter(config, serving(ROWS)).readHistory({ id: '15' })).rejects.toThrow(
            /radarr or sonarr/i
        );
    });
});
