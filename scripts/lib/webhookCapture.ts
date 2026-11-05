/**
 * The listener behind `npm run capture:webhooks`, apart from the script so it can
 * be tested: the script itself loads a real config on import.
 *
 * It listens on the network and names files from what it receives, so both names
 * are checked against fixed rules before they reach a path, and every request must
 * carry a password that exists only for this run.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { ANONYMOUS_URL, hostsInAuthorityPosition, isRow, redact } from './redact.ts';

/**
 * The *arrs that send library events and whose fixtures can publish real titles.
 * Whisparr is left out on purpose: its library is the sensitive part, and the
 * scrubbing here keeps titles.
 */
export const CAPTURE_SERVICES = ['radarr', 'sonarr', 'lidarr'] as const;

/** Task 9's route takes the same limit, so a payload too big for it shows up now. */
export const MAX_BODY_BYTES = 256 * 1024;

const EVENT_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

const RELEASE_NAME = 'Release.Name.1080p.WEB-DL.x264-GROUP';
const PLACEHOLDER_PATH = '/media/library/item';

/** Replaced by key, because their values look like any other text. Lower case. */
const REPLACED_KEYS: Record<string, string> = {
    releasetitle: RELEASE_NAME,
    scenename: RELEASE_NAME,
    sourcetitle: RELEASE_NAME,
    releasegroup: 'GROUP',
    indexer: 'Indexer',
    downloadclient: 'Download Client',
    instancename: 'Instance',
    // Free text from a health check or a stuck download can quote a path or a host.
    message: 'A message.',
    messages: 'A message.'
};

/** Inside these, `title` is a release name rather than a film or a series. */
const DOWNLOAD_ROWS = new Set(['downloadInfo', 'downloadStatusMessages']);

const DOWNLOAD_ID_KEY = /^(?:downloadid|infohash|hash)$/i;
const PATH_KEY = /path|folder/i;
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;
const URL_OR_MAGNET = /(?:https?:\/\/|magnet:)[^\s"',\]]+/gi;

export type DownloadIdMapper = (id: string) => string;

/**
 * A torrent's download id is its info hash, which names the release exactly. One
 * real id keeps one placeholder for the whole run, so a grab and its import still
 * link. Upper case, as the *arrs send it: Task 9 has to lower-case it.
 */
export function createDownloadIdMapper(): DownloadIdMapper {
    const seen = new Map<string, string>();
    return id => {
        const key = id.toLowerCase();
        const known = seen.get(key);
        if (known !== undefined) return known;
        const placeholder = String(seen.size + 1).padStart(40, 'A');
        seen.set(key, placeholder);
        return placeholder;
    };
}

function scrubString(key: string, value: string, inDownloadRow: boolean, mapId: DownloadIdMapper): string {
    if (value === '') return value;
    const replacement = REPLACED_KEYS[key.toLowerCase()];
    if (replacement !== undefined) return replacement;
    if (inDownloadRow && key === 'title') return RELEASE_NAME;
    if (DOWNLOAD_ID_KEY.test(key)) return mapId(value);
    if (PATH_KEY.test(key) || ABSOLUTE_PATH.test(value)) return PLACEHOLDER_PATH;
    return value.replace(URL_OR_MAGNET, ANONYMOUS_URL);
}

function walk(node: unknown, key: string, inDownloadRow: boolean, mapId: DownloadIdMapper): unknown {
    if (typeof node === 'string') return scrubString(key, node, inDownloadRow, mapId);
    if (Array.isArray(node)) return node.map(item => walk(item, key, inDownloadRow, mapId));
    if (isRow(node)) {
        return Object.fromEntries(
            Object.entries(node).map(([k, v]) => [k, walk(v, k, inDownloadRow || DOWNLOAD_ROWS.has(k), mapId)])
        );
    }
    return node;
}

/**
 * Removes who and where you are, and keeps titles and ids, which are what the
 * parser reads and are public facts. Keys and types survive, values are replaced.
 * This is a list of known fields, so a person still reads every file before commit.
 */
export function anonymiseWebhook(body: unknown, mapId: DownloadIdMapper): unknown {
    return walk(body, '', false, mapId);
}

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Hashed first, so differing lengths compare safely. */
const sameSecret = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

function hasCredentials(header: string, username: string, password: string): boolean {
    const decoded = Buffer.from(header.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon === -1) return false;
    // Both are always compared, so a right username takes no less time than a wrong one.
    const user = sameSecret(decoded.slice(0, colon), username);
    const pass = sameSecret(decoded.slice(colon + 1), password);
    return user && pass;
}

/** Reads to the end even past the limit, so the sender gets the 413 rather than a reset. */
async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size <= MAX_BODY_BYTES) chunks.push(chunk as Buffer);
    }
    return size > MAX_BODY_BYTES ? undefined : Buffer.concat(chunks);
}

export type CaptureOptions = {
    port: number;
    host: string;
    outDir: string;
    username: string;
    password: string;
    secrets: string[];
    hosts: string[];
    log: (line: string) => void;
};

export type CaptureServer = { server: Server; close: () => Promise<void> };

const answer = (res: ServerResponse, status: number, text: string, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'text/plain', ...headers });
    res.end(`${text}\n`);
};

export async function startCaptureServer(options: CaptureOptions): Promise<CaptureServer> {
    const { outDir, username, password, secrets, hosts, log } = options;
    const mapId = createDownloadIdMapper();

    const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        const service = (CAPTURE_SERVICES as readonly string[]).find(
            s => `/${s}` === new URL(req.url ?? '/', 'http://capture.invalid').pathname
        );
        if (service === undefined) return answer(res, 404, 'Use /radarr, /sonarr or /lidarr.');
        if (req.method !== 'POST') return answer(res, 405, 'POST only.');

        const header = req.headers.authorization;
        if (header === undefined || !/^Basic\s/i.test(header)) {
            log(`${service}: request had no Basic Authorization header, refused`);
            return answer(res, 401, 'Basic auth required.', { 'www-authenticate': 'Basic realm="capture"' });
        }
        if (!hasCredentials(header, username, password)) {
            log(`${service}: Basic header arrived with the wrong username or password, refused`);
            return answer(res, 401, 'Wrong credentials.', { 'www-authenticate': 'Basic realm="capture"' });
        }

        const raw = await readBody(req);
        if (raw === undefined) {
            log(`${service}: body over ${MAX_BODY_BYTES} bytes, not saved`);
            return answer(res, 413, 'Too large.');
        }

        let body: unknown;
        try {
            body = JSON.parse(raw.toString('utf8'));
        } catch {
            log(`${service}: body is not JSON, not saved`);
            return answer(res, 400, 'Not JSON.');
        }

        const eventType = isRow(body) ? body.eventType : undefined;
        if (typeof eventType !== 'string' || !EVENT_NAME.test(eventType)) {
            log(`${service}: no usable eventType, not saved`);
            return answer(res, 400, 'No usable eventType.');
        }

        const serialised = JSON.stringify(redact(anonymiseWebhook(body, mapId), secrets, hosts), null, 2);

        // The same gate capture-fixtures.ts uses. Redaction rewrites values, so what
        // this catches is a credential or a host somewhere it does not look.
        if (secrets.some(secret => serialised.includes(secret)) || hostsInAuthorityPosition(serialised, hosts)) {
            log(`REFUSING TO WRITE ${service}/${eventType}: a configured credential or host survived redaction`);
            return answer(res, 500, 'Refused to save.');
        }

        await mkdir(join(outDir, service), { recursive: true });
        await writeFile(join(outDir, service, `${eventType}.json`), `${serialised}\n`);
        log(`saved ${service}/${eventType} (Basic auth arrived)`);
        answer(res, 200, 'Saved.');
    };

    const server = createServer((req, res) => {
        handle(req, res).catch((err: unknown) => {
            log(`request failed: ${(err as Error).name}`);
            if (!res.headersSent) answer(res, 500, 'Failed.');
        });
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, options.host, resolve);
    });

    return {
        server,
        close: () =>
            new Promise<void>(resolve => {
                server.close(() => resolve());
                server.closeAllConnections();
            })
    };
}
