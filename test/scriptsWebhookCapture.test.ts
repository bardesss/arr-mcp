import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { anonymiseWebhook, createDownloadIdMapper, startCaptureServer, type CaptureServer } from '../scripts/lib/webhookCapture.ts';

const PASSWORD = 'one-run-password';
const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
const GOOD = basic('capture', PASSWORD);

type Scrubbed = Record<string, Record<string, unknown> | undefined>;

describe('anonymiseWebhook', () => {
    const anonymise = (body: unknown) => anonymiseWebhook(body, createDownloadIdMapper()) as Scrubbed;

    it('keeps what the parser will read: event, title, ids', () => {
        const out = anonymise({ eventType: 'Grab', movie: { id: 7, title: 'The Matrix', year: 1999, tmdbId: 603, imdbId: 'tt0133093' } });
        expect(out).toEqual({ eventType: 'Grab', movie: { id: 7, title: 'The Matrix', year: 1999, tmdbId: 603, imdbId: 'tt0133093' } });
    });

    it('replaces where the library lives, whatever the key is called', () => {
        const out = anonymise({
            movie: { folderPath: 'D:\\Films\\The Matrix (1999)' },
            movieFile: { path: '/mnt/user/films/matrix.mkv', relativePath: 'matrix.mkv' },
            renamedMovieFiles: [{ previousPath: '/mnt/user/old.mkv', previousRelativePath: 'old.mkv' }],
            somethingNew: '/home/bartus/private',
            alsoNew: '\\\\nas\\share\\films'
        });
        const text = JSON.stringify(out);
        for (const leak of ['Films', 'mnt', 'matrix.mkv', 'old.mkv', 'bartus', 'nas']) expect(text).not.toContain(leak);
        expect(typeof out.movieFile?.path).toBe('string');
    });

    it('replaces release names, indexers, clients and the instance name', () => {
        const out = anonymise({
            instanceName: 'My Radarr',
            downloadClient: 'Seedbox',
            release: { releaseTitle: 'The.Matrix.1999.x264-REAL', indexer: 'PrivateTracker', releaseGroup: 'REAL', size: 5 },
            movieFile: { sceneName: 'The.Matrix.1999.x264-REAL' }
        });
        const text = JSON.stringify(out);
        for (const leak of ['My Radarr', 'Seedbox', 'REAL', 'PrivateTracker']) expect(text).not.toContain(leak);
        expect(out.release?.size).toBe(5);
    });

    it('treats a title as a release name only inside download status rows', () => {
        const out = anonymise({
            movie: { title: 'The Matrix' },
            downloadInfo: { title: 'The.Matrix.1999.x264-REAL' },
            downloadStatusMessages: [{ title: 'The.Matrix.1999.x264-REAL', messages: ['/mnt/user/bad file'] }]
        });
        expect(out.movie?.title).toBe('The Matrix');
        expect(JSON.stringify(out)).not.toContain('REAL');
        expect(JSON.stringify(out)).not.toContain('bad file');
    });

    it('removes a free-text message, which can quote a path or a host', () => {
        const out = anonymise({ eventType: 'Health', message: 'Cannot reach seedbox', level: 'warning' });
        expect(JSON.stringify(out)).not.toContain('seedbox');
        expect(out.level).toBe('warning');
    });

    it('replaces every absolute URL, in any field', () => {
        const out = anonymise({ applicationUrl: 'https://radarr.example.org/?apikey=abc', movie: { images: [{ remoteUrl: 'https://cdn.example.org/a.jpg' }] } });
        expect(JSON.stringify(out)).not.toContain('example.org');
    });

    it('gives one download id one placeholder, in upper case, so grab and import still link', () => {
        const map = createDownloadIdMapper();
        const grab = anonymiseWebhook({ downloadId: 'ABCDEF123' }, map) as { downloadId: string };
        const imported = anonymiseWebhook({ downloadId: 'ABCDEF123' }, map) as { downloadId: string };
        const other = anonymiseWebhook({ downloadId: 'ZZZ' }, map) as { downloadId: string };
        expect(imported.downloadId).toBe(grab.downloadId);
        expect(other.downloadId).not.toBe(grab.downloadId);
        expect(grab.downloadId).not.toContain('ABCDEF123');
        expect(grab.downloadId).toBe(grab.downloadId.toUpperCase());
    });

    it('leaves null and empty values alone, so the shape survives', () => {
        expect(anonymise({ movieFile: { sceneName: null, path: '' } })).toEqual({ movieFile: { sceneName: null, path: '' } });
    });
});

describe('capture server', () => {
    let dir: string;
    let server: CaptureServer;
    let logs: string[];
    let url: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'webhook-capture-'));
        logs = [];
        server = await startCaptureServer({
            port: 0,
            host: '127.0.0.1',
            outDir: dir,
            username: 'capture',
            password: PASSWORD,
            secrets: ['service-api-key'],
            hosts: ['radarr.lan'],
            log: line => logs.push(line)
        });
        url = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
        await server.close();
        await rm(dir, { recursive: true, force: true });
    });

    const post = (path: string, body: unknown, authorization: string | null = GOOD) =>
        fetch(`${url}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(authorization === null ? {} : { authorization }) },
            body: typeof body === 'string' ? body : JSON.stringify(body)
        });

    const written = async () => (await readdir(dir, { recursive: true })).map(String).sort();

    it('writes one scrubbed file per service and event', async () => {
        const res = await post('/radarr', { eventType: 'Grab', instanceName: 'My Radarr', movie: { title: 'The Matrix' } });
        expect(res.status).toBe(200);
        const saved = JSON.parse(await readFile(join(dir, 'radarr', 'Grab.json'), 'utf8')) as Scrubbed;
        expect(saved.movie?.title).toBe('The Matrix');
        expect(saved.instanceName).not.toBe('My Radarr');
        expect(logs.join('\n')).toContain('radarr/Grab');
    });

    it('refuses a request with no Basic header, says so, and asks for it', async () => {
        const res = await post('/radarr', { eventType: 'Grab' }, null);
        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate')).toContain('Basic');
        expect(await written()).toEqual([]);
        expect(logs.join('\n')).toContain('no Basic');
    });

    it('refuses the wrong password and never logs a credential', async () => {
        const res = await post('/radarr', { eventType: 'Grab' }, basic('capture', 'guess-one'));
        expect(res.status).toBe(401);
        expect(await written()).toEqual([]);
        expect(logs.join('\n')).not.toContain('guess-one');
        expect(logs.join('\n')).not.toContain(PASSWORD);
    });

    it('takes the service from a fixed list, so a path cannot leave the fixture folder', async () => {
        for (const path of ['/whisparr', '/prowlarr', '/..', '/radarr/extra', '/', '/%2e%2e%2fescape']) {
            const res = await post(path, { eventType: 'Grab' });
            expect(res.status, path).toBe(404);
        }
        expect(await written()).toEqual([]);
    });

    it('takes the file name only from a plain event name', async () => {
        for (const eventType of ['../../evil', 'a/b', 'a\\b', '', 'Grab.json', 7, undefined]) {
            const res = await post('/radarr', { eventType });
            expect(res.status, String(eventType)).toBe(400);
        }
        expect(await written()).toEqual([]);
    });

    it('answers 400 for malformed JSON and 405 for anything but POST', async () => {
        expect((await post('/radarr', '{nope')).status).toBe(400);
        expect((await fetch(`${url}/radarr`, { headers: { authorization: GOOD } })).status).toBe(405);
        expect(await written()).toEqual([]);
    });

    it('answers 413 past 256 KiB and writes nothing', async () => {
        const res = await post('/radarr', { eventType: 'Grab', padding: 'x'.repeat(256 * 1024) });
        expect(res.status).toBe(413);
        expect(await written()).toEqual([]);
    });

    it('refuses to write when a configured credential survives scrubbing', async () => {
        // Redaction rewrites values, so a key is the one place one can survive.
        const res = await post('/radarr', { eventType: 'Grab', 'service-api-key': 1 });
        expect(res.status).toBe(500);
        expect(await written()).toEqual([]);
        expect(logs.join('\n')).toContain('REFUSING');
        expect(logs.join('\n')).not.toContain('service-api-key');
    });

    it('redacts credentials, secret-named fields and configured hosts on the way through', async () => {
        const res = await post('/radarr', { eventType: 'Grab', apiKey: 'other-key', note: 'see //radarr.lan:7878/x', other: 'has service-api-key inside' });
        expect(res.status).toBe(200);
        const text = await readFile(join(dir, 'radarr', 'Grab.json'), 'utf8');
        for (const leak of ['other-key', 'radarr.lan', 'service-api-key']) expect(text).not.toContain(leak);
    });
});
