import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGzip } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImdbDataset } from '../src/metadata/imdbDataset.ts';
import { ingestOnce, linesOf } from '../src/metadata/refresh.ts';

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

const ALL = {
    'title.basics.tsv.gz': BASICS,
    'title.ratings.tsv.gz': RATINGS
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

/**
 * The fix for a crash found by the first real ingest: `title.basics` is ~12M
 * lines, and buffering them cost about 4 GB of heap and killed the process.
 * Lines are now read from a staged file a megabyte at a time.
 *
 * The subtle risk in doing that is the chunk boundary — a line straddling two
 * reads must be stitched, not split, and getting it wrong corrupts quietly
 * rather than throwing.
 */
describe('reading a staged dump', () => {
    const write = (text: string): string => {
        const dir = mkdtempSync(join(tmpdir(), 'lines-'));
        const path = join(dir, 'dump.tsv');
        writeFileSync(path, text, 'utf8');
        return path;
    };

    it('yields each line', () => {
        expect([...linesOf(write('a\nb\nc'))]).toEqual(['a', 'b', 'c']);
    });

    it('keeps the last line when the file does not end in a newline', () => {
        expect([...linesOf(write('a\nb'))]).toEqual(['a', 'b']);
    });

    it('yields nothing for an empty file', () => {
        expect([...linesOf(write(''))]).toEqual([]);
    });

    /** The whole reason the carry exists. */
    it('stitches a line that straddles the 1 MB read boundary', () => {
        const long = 'x'.repeat(1_500_000);
        const lines = [...linesOf(write(`first\n${long}\nlast`))];

        expect(lines).toHaveLength(3);
        expect(lines[1]).toHaveLength(1_500_000);
        expect(lines[2]).toBe('last');
    });

    it('stitches a multibyte character that straddles the read boundary', () => {
        // The straddle test above uses ASCII, so it never exercised the other
        // half of the boundary problem: each 1 MiB read was decoded on its own,
        // and a character whose bytes span two reads was two invalid halves —
        // U+FFFD in the title, which is what discover_media then returns as
        // the film's name. "Amélie" is exactly the kind of title this hits.
        const pad = 'x'.repeat((1 << 20) - 1);
        const lines = [...linesOf(write(`${pad}é\nlast`))];

        expect(lines[0]?.endsWith('é')).toBe(true);
        expect(lines[0]).not.toContain('�');
        expect(lines[1]).toBe('last');
    });

    /** Lazy, not materialised — the property the crash was caused by losing. */
    it('reads lazily rather than loading the file', () => {
        const gen = linesOf(write('a\nb\nc'));
        expect(gen.next().value).toBe('a');
        gen.return(undefined);
    });
});
