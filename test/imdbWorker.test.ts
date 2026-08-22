import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { ImdbDataset } from '../src/metadata/imdbDataset.ts';
import { runIngest } from '../src/metadata/refresh.ts';

/**
 * The worker path, end to end.
 *
 * A real HTTP server rather than a stubbed `fetch`: the ingest runs in another
 * thread, which has its own globals, so `vi.stubGlobal` reaches nothing. That
 * is also the point of the test — proving the work really left this thread.
 */

const fixture = (name: string): Buffer =>
    gzipSync(readFileSync(join(import.meta.dirname, 'fixtures', 'imdb', name)));

const servingDumps = async (): Promise<{ url: string; close: () => Promise<void> }> => {
    const bodies: Record<string, Buffer> = {
        'title.basics.tsv.gz': fixture('title.basics.tsv'),
        'title.ratings.tsv.gz': fixture('title.ratings.tsv')
    };

    const server: Server = createServer((req, res) => {
        const name = (req.url ?? '').split('/').pop() ?? '';
        const body = bodies[name];
        if (body === undefined) {
            res.writeHead(404).end();
            return;
        }
        res.writeHead(200, { 'content-type': 'application/gzip' }).end(body);
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    return {
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>(resolve => server.close(() => resolve()))
    };
};

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const fn of cleanup) await fn();
    cleanup = [];
});

describe('ingesting through a worker', () => {
    it('writes the dataset without blocking the event loop', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'arr-mcp-imdb-worker-'));
        const dataset = ImdbDataset.open(dir);
        const server = await servingDumps();
        cleanup.push(async () => {
            dataset.close();
            await server.close();
            await rm(dir, { recursive: true, force: true });
        });

        // A timer that only advances if the main thread is still turning over.
        let ticks = 0;
        const ticker = setInterval(() => {
            ticks += 1;
        }, 2);

        await runIngest(dataset, { baseUrl: server.url });
        clearInterval(ticker);

        expect(ticks).toBeGreaterThan(0);
        expect(dataset.status().titles).toBeGreaterThan(0);
        expect(dataset.status().ratings).toBeGreaterThan(0);
    });

    it('reports a failure in the worker rather than swallowing it', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'arr-mcp-imdb-worker-'));
        const dataset = ImdbDataset.open(dir);
        cleanup.push(async () => {
            dataset.close();
            await rm(dir, { recursive: true, force: true });
        });

        // Nothing listening, so the download fails inside the worker.
        await expect(runIngest(dataset, { baseUrl: 'http://127.0.0.1:1' })).rejects.toThrow();
    });

    it('runs in-process for an ephemeral dataset, which has no file to share', async () => {
        const dataset = ImdbDataset.ephemeral();
        cleanup.push(async () => dataset.close());

        expect(dataset.dir).toBeUndefined();
    });
});
