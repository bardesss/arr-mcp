import { createGzip } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImdbDataset } from '../src/metadata/imdbDataset.ts';
import { ingestOnce } from '../src/metadata/refresh.ts';

/**
 * The one file that touches the network, driven against a stubbed `fetch`
 * serving real gzipped TSV — so the streaming and decompression are exercised
 * rather than mocked away.
 */

let db: ImdbDataset;
afterEach(() => {
    db?.close();
    vi.unstubAllGlobals();
});

const gzipped = (text: string): Promise<Buffer> =>
    new Promise(resolve => {
        const chunks: Buffer[] = [];
        const gz = createGzip();
        gz.on('data', (c: Buffer) => chunks.push(c));
        gz.on('end', () => resolve(Buffer.concat(chunks)));
        gz.end(text);
    });

const serve = async (files: Record<string, string>): Promise<void> => {
    const bodies: Record<string, Buffer> = {};
    for (const [name, text] of Object.entries(files)) bodies[name] = await gzipped(text);

    vi.stubGlobal('fetch', async (url: string | URL) => {
        const name = String(url).split('/').pop() ?? '';
        const body = bodies[name];
        if (body === undefined) return new Response('not found', { status: 404 });
        return new Response(new Uint8Array(body));
    });
};

const BASICS =
    'tconst\ttitleType\tprimaryTitle\toriginalTitle\tisAdult\tstartYear\tendYear\truntimeMinutes\tgenres\n' +
    'tt0903747\ttvSeries\tBreaking Bad\tBreaking Bad\t0\t2008\t2013\t49\tCrime,Drama';
const RATINGS = 'tconst\taverageRating\tnumVotes\ntt0903747\t9.5\t2200000';
const EPISODES = 'tconst\tparentTconst\tseasonNumber\tepisodeNumber\ntt2081647\ttt0903747\t1\t1';

const ALL = {
    'title.basics.tsv.gz': BASICS,
    'title.ratings.tsv.gz': RATINGS,
    'title.episode.tsv.gz': EPISODES
};

const BASE = 'https://example.test';

describe('ingesting from the published dumps', () => {
    it('downloads, decompresses and loads all three files', async () => {
        await serve(ALL);
        db = ImdbDataset.ephemeral();

        await ingestOnce(db, { baseUrl: BASE });

        expect(db.status().titles).toBe(1);
        expect(db.ratingsFor(['tt0903747']).get('tt0903747')).toBe(9.5);
        expect(db.status().ingestedAt).toBeDefined();
    });

    /**
     * The failure this ordering exists to prevent. A download that dies
     * between the first file and the third would otherwise leave today's
     * titles standing against yesterday's ratings — a dataset that answers
     * confidently from a mixture of two days, with nothing to show it.
     */
    it('leaves the previous dataset intact when a later download fails', async () => {
        await serve(ALL);
        db = ImdbDataset.ephemeral();
        await ingestOnce(db, { baseUrl: BASE });

        // Ratings and episodes now 404.
        await serve({ 'title.basics.tsv.gz': BASICS });

        await expect(ingestOnce(db, { baseUrl: BASE })).rejects.toThrow();
        expect(db.status().titles).toBe(1);
        expect(db.ratingsFor(['tt0903747']).get('tt0903747')).toBe(9.5);
    });

    it('names the file it could not fetch, so a failure is diagnosable', async () => {
        await serve({});
        db = ImdbDataset.ephemeral();

        await expect(ingestOnce(db, { baseUrl: BASE })).rejects.toThrow('title.basics.tsv.gz');
    });
});
