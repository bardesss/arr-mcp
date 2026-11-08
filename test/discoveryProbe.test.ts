import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { CatalogEntry, ProbeResponse } from '../src/discovery/catalog.ts';
import { probeEntry, probeHost } from '../src/discovery/probe.ts';

type Handler = Parameters<typeof createServer>[1];

let server: Server | undefined;
const sockets = new Set<Socket>();

const serve = async (handler: Handler): Promise<number> => {
    server = createServer(handler);
    server.on('connection', s => {
        sockets.add(s);
        s.on('close', () => sockets.delete(s));
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
};

afterEach(async () => {
    for (const s of sockets) s.destroy();
    sockets.clear();
    const s = server;
    server = undefined;
    if (s) await new Promise<void>(resolve => s.close(() => resolve()));
});

const entry = (port: number, over: Partial<CatalogEntry> = {}): CatalogEntry => ({
    type: 'radarr',
    port,
    containerNames: ['radarr'],
    path: '/ping',
    identify: r => (r.status === 200 && r.body.includes('hello') ? { version: '1.2.3' } : undefined),
    ...over
});

const opts = { timeoutMs: 2000 };

describe('probeEntry', () => {
    it('finds a service whose fingerprint matches', async () => {
        const port = await serve((_req, res) => res.end('hello'));
        expect(await probeEntry('127.0.0.1', entry(port), 'host', opts)).toEqual({
            type: 'radarr',
            url: `http://127.0.0.1:${port}`,
            version: '1.2.3',
            source: 'host'
        });
    });

    it('a non-matching response finds nothing', async () => {
        const port = await serve((_req, res) => res.end('nope'));
        expect(await probeEntry('127.0.0.1', entry(port), 'host', opts)).toBeUndefined();
    });

    it('sends no credentials', async () => {
        let seen: IncomingHttpHeaders | undefined;
        let method: string | undefined;
        const port = await serve((req, res) => {
            seen = req.headers;
            method = req.method;
            res.end('hello');
        });
        await probeEntry('127.0.0.1', entry(port), 'host', opts);
        expect(method).toBe('GET');
        expect(seen).toBeDefined();
        expect(seen).not.toHaveProperty('authorization');
        expect(seen).not.toHaveProperty('cookie');
        expect(seen).not.toHaveProperty('x-api-key');
    });

    it('does not follow a redirect off the host', async () => {
        let hits = 0;
        let got: ProbeResponse | undefined;
        const port = await serve((_req, res) => {
            hits++;
            res.writeHead(302, { location: 'http://example.com/' }).end();
        });
        await probeEntry(
            '127.0.0.1',
            entry(port, {
                identify: r => {
                    got = r;
                    return undefined;
                }
            }),
            'host',
            opts
        );
        expect(got?.status).toBe(302);
        expect(got?.headers.location).toBe('http://example.com/');
        expect(hits).toBe(1);
    });

    it('a held connection times out', async () => {
        const port = await serve(() => {});
        const t0 = Date.now();
        expect(await probeEntry('127.0.0.1', entry(port), 'host', { timeoutMs: 200 })).toBeUndefined();
        expect(Date.now() - t0).toBeLessThan(1000);
    });

    it('a huge body is capped', async () => {
        let length = -1;
        const port = await serve((_req, res) => {
            const chunk = Buffer.alloc(64 * 1024, 'a');
            let left = 10 * 1024 * 1024;
            const pump = () => {
                while (left > 0) {
                    left -= chunk.length;
                    if (!res.write(chunk)) return void res.once('drain', pump);
                }
                res.end();
            };
            res.on('error', () => {});
            pump();
        });
        await probeEntry(
            '127.0.0.1',
            entry(port, {
                identify: r => {
                    length = r.body.length;
                    return undefined;
                }
            }),
            'host',
            opts
        );
        expect(length).toBeGreaterThan(0);
        expect(length).toBeLessThanOrEqual(65536);
    });

    it('a refused port finds nothing', async () => {
        const port = await serve((_req, res) => res.end('hello'));
        await new Promise<void>(resolve => server!.close(() => resolve()));
        server = undefined;
        await expect(probeEntry('127.0.0.1', entry(port), 'host', opts)).resolves.toBeUndefined();
    });

    it('connects to the address but names the host in the url', async () => {
        const port = await serve((_req, res) => res.end('hello'));
        const found = await probeEntry('example.invalid', entry(port), 'container', { ...opts, address: '127.0.0.1' });
        expect(found?.url).toBe(`http://example.invalid:${port}`);
        expect(found?.source).toBe('container');
    });

    it('brackets IPv6 in the url', async () => {
        const port = await serve((_req, res) => res.end('hello'));
        const found = await probeEntry('fd00::1', entry(port), 'sweep', { ...opts, address: '127.0.0.1' });
        expect(found?.url).toBe(`http://[fd00::1]:${port}`);
    });
});

describe('probeHost', () => {
    it('fetches each (port, path) once and shares the response', async () => {
        const paths: string[] = [];
        const port = await serve((req, res) => {
            paths.push(req.url ?? '');
            res.end(req.url === '/a' ? 'alpha' : 'beta');
        });
        const a1 = entry(port, { type: 'radarr', path: '/a', identify: r => (r.body === 'alpha' ? {} : undefined) });
        const a2 = entry(port, { type: 'sonarr', path: '/a', identify: r => (r.body === 'alpha' ? { version: '9' } : undefined) });
        const b = entry(port, { type: 'lidarr', path: '/b', identify: r => (r.body === 'beta' ? {} : undefined) });
        const found = await probeHost('127.0.0.1', [a1, a2, b], 'sweep', opts);
        expect(paths.sort()).toEqual(['/a', '/b']);
        expect(found.map(f => f.type).sort()).toEqual(['lidarr', 'radarr', 'sonarr']);
        expect(found.find(f => f.type === 'sonarr')?.version).toBe('9');
    });

    it('returns nothing when the port is refused', async () => {
        const port = await serve((_req, res) => res.end('x'));
        await new Promise<void>(resolve => server!.close(() => resolve()));
        server = undefined;
        expect(await probeHost('127.0.0.1', [entry(port)], 'host', opts)).toEqual([]);
    });
});
