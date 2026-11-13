import { instancesOf } from './helpers/instances.ts';
import { describe, expect, it, vi } from 'vitest';
import type * as z from 'zod/v4';
import type { AnyServiceConfig, CredentialServiceConfig, KeyedServiceConfig, ServiceId } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { NzbgetAdapter } from '../src/services/nzbget.ts';
import { QbittorrentAdapter } from '../src/services/qbittorrent.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import { SabnzbdAdapter } from '../src/services/sabnzbd.ts';
import { TransmissionAdapter } from '../src/services/transmission.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import type { LibraryLoader } from '../src/tools/library.ts';
import { registerPauseDownloads } from '../src/tools/pauseDownloads.ts';
import type { WriteToolResult } from '../src/tools/write.ts';
import { jsonResponse } from './helpers/serve.ts';

/**
 * Three hand-rolled clients, two of which answer failure with HTTP 200, and
 * one that is not on the maintainer's stack at all. Every assertion here about
 * qBittorrent is spec-derived and labelled as such; Transmission and SABnzbd
 * were probed live.
 */

const keyed = (port: number): KeyedServiceConfig => ({
    url: `http://192.0.2.10:${port}`,
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: true, destructive: false }
});

const credential = (port: number): CredentialServiceConfig => ({
    url: `http://192.0.2.10:${port}`,
    timeout_ms: 10_000,
    permissions: { safe_write: true, destructive: false }
});

const rpc = (result: unknown) => jsonResponse(result);
const HASH = 'a'.repeat(40);

// --- adapters ------------------------------------------------------------

describe('transmission pause', () => {
    const adapterWith = (impl: typeof fetch) => new TransmissionAdapter(credential(9091), impl);

    it('treats a 200 with a non-success result as a failure', async () => {
        // Every Transmission failure arrives as HTTP 200. Trusting the status
        // line would report a pause that never happened.
        const impl = (async () => rpc({ result: 'no such torrent' })) as unknown as typeof fetch;
        await expect(adapterWith(impl).setPaused(true)).rejects.toThrow(/no such torrent/);
    });

    it('fences the result text, which can quote a tracker or the filesystem', async () => {
        const impl = (async () => rpc({ result: 'disk full <</>> now' })) as unknown as typeof fetch;
        await expect(adapterWith(impl).setPaused(true)).rejects.toThrow(
            /<<untrusted:transmission\.result>>disk full \\u003c\\u003c\/\\u003e\\u003e now<<\/>>/
        );
    });

    it('refuses an id it cannot find rather than reporting success', async () => {
        // Probed live: `torrent-stop` for an id that does not exist answers
        // `result: "success"` and does nothing.
        const impl = (async (_i: unknown, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body)) as { method: string };
            if (body.method === 'torrent-get') return rpc({ result: 'success', arguments: { torrents: [] } });
            return rpc({ result: 'success' });
        }) as unknown as typeof fetch;

        await expect(adapterWith(impl).setPaused(true, '5')).rejects.toThrow(/no torrent/);
    });

    it('sends torrent-stop to pause and torrent-start to resume', async () => {
        const methods: string[] = [];
        const impl = (async (_i: unknown, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body)) as { method: string };
            methods.push(body.method);
            if (body.method === 'torrent-get') {
                return rpc({ result: 'success', arguments: { torrents: [{ id: 5, status: 4 }] } });
            }
            return rpc({ result: 'success' });
        }) as unknown as typeof fetch;

        const adapter = adapterWith(impl);
        await adapter.setPaused(true, '5');
        await adapter.setPaused(false, '5');
        expect(methods).toContain('torrent-stop');
        expect(methods).toContain('torrent-start');
    });

    // 300 torrents stopped at their ratio and 2 downloading: a pause and a
    // resume must leave the 300 stopped, not start them seeding again.
    it('resumes only the torrents its pause stopped', async () => {
        const fake = transmissionFake([
            { id: 1, hashString: hashOf('1'), status: 0, labels: [] },
            { id: 2, hashString: hashOf('2'), status: 4, labels: ['movies'] },
            { id: 3, hashString: hashOf('3'), status: 6, labels: [] }
        ]);
        const adapter = adapterWith(fake.fetch);

        expect((await adapter.readPauseState()).torrents).toEqual({
            running: 2,
            stopped: 1,
            marked: 0,
            mark: 'label arr-mcp-paused',
            runningIds: [hashOf('2'), hashOf('3')],
            markedIds: []
        });
        await adapter.setPaused(true);
        expect(fake.torrents.map(t => [t.status, t.labels])).toEqual([
            [0, []],
            [0, ['movies', 'arr-mcp-paused']],
            [0, ['arr-mcp-paused']]
        ]);
        expect((await adapter.readPauseState()).paused).toBe(true);

        // An *arr sends a release, which starts at once: the client still reads as paused.
        fake.torrents.push({ id: 4, hashString: hashOf('4'), status: 4, labels: [] });
        expect((await adapter.readPauseState()).paused).toBe(true);

        await adapter.setPaused(false);
        expect(fake.torrents.map(t => [t.status, t.labels])).toEqual([
            [0, []],
            [4, ['movies']],
            [4, []],
            [4, []]
        ]);
        expect(fake.calls.filter(c => c.method === 'torrent-start' || c.method === 'torrent-stop').every(c => Array.isArray(c.arguments?.ids))).toBe(true);
    });

    // The label is this server's bookkeeping, not the user's: get_queue and the
    // Cleanuparr rule match never see it.
    it('leaves its own label out of the queue facts', async () => {
        const fake = transmissionFake([{ id: 1, hashString: hashOf('1'), status: 0, labels: ['arr-mcp-paused', 'tv'] }]);
        const [row] = await adapterWith(fake.fetch).getQueue();
        expect(row?.torrent?.tags).toEqual(['tv']);
    });

    it('unlabels a torrent resumed by its own id', async () => {
        const fake = transmissionFake([{ id: 1, hashString: hashOf('1'), status: 0, labels: ['arr-mcp-paused', 'tv'] }]);
        await adapterWith(fake.fetch).setPaused(false, hashOf('1'));
        expect(fake.torrents[0]).toMatchObject({ status: 4, labels: ['tv'] });
    });

    it('refuses a whole-client pause on a daemon without labels', async () => {
        const fake = transmissionFake([{ id: 1, hashString: hashOf('1'), status: 4, labels: [] }], 15);
        await expect(adapterWith(fake.fetch).readPauseState()).rejects.toThrow(/no torrent labels/);
        await expect(adapterWith(fake.fetch).setPaused(true)).rejects.toThrow(/one at a time with `id`/);
        expect(fake.torrents[0]?.status).toBe(4);
    });

    it('reads one torrent by hash or by its integer id, and refuses one it does not have', async () => {
        const fake = transmissionFake([{ id: 7, hashString: hashOf('7'), status: 0, labels: [] }]);
        const adapter = adapterWith(fake.fetch);
        expect((await adapter.readPauseState(hashOf('7'))).paused).toBe(true);
        expect((await adapter.readPauseState('7')).paused).toBe(true);
        await expect(adapter.readPauseState(hashOf('8'))).rejects.toThrow(/no torrent/);
    });

    it.each(['', '0x1f', '1e1', '1.5', 'abc'])('refuses %j as a torrent id before Transmission is called', async id => {
        const fake = transmissionFake([]);
        await expect(adapterWith(fake.fetch).readPauseState(id)).rejects.toThrow(/not a Transmission torrent id/);
        expect(fake.calls).toEqual([]);
    });
});

type FakeTorrent = { id: number; hashString: string; status: number; labels: string[] };
const hashOf = (c: string): string => c.repeat(40);

/** An in-memory Transmission that applies stop, start and label writes. */
function transmissionFake(torrents: FakeTorrent[], rpcVersion = 17) {
    const calls: { method: string; arguments?: { ids?: (string | number)[]; labels?: string[] } }[] = [];
    const pick = (ids?: (string | number)[]) =>
        ids === undefined ? torrents : torrents.filter(t => ids.includes(t.id) || ids.includes(t.hashString));
    const impl = (async (_i: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as (typeof calls)[number];
        calls.push(body);
        const args = body.arguments;
        if (body.method === 'session-get') return rpc({ result: 'success', arguments: { version: '4.0.6', 'rpc-version': rpcVersion } });
        if (body.method === 'torrent-get') return rpc({ result: 'success', arguments: { torrents: pick(args?.ids).map(t => ({ ...t })) } });
        for (const t of pick(args?.ids)) {
            if (body.method === 'torrent-stop') t.status = 0;
            if (body.method === 'torrent-start') t.status = 4;
            if (body.method === 'torrent-set' && args?.labels) t.labels = [...args.labels];
        }
        return rpc({ result: 'success' });
    }) as unknown as typeof fetch;
    return { torrents, calls, fetch: impl };
}

describe('sabnzbd pause', () => {
    const adapterWith = (impl: typeof fetch) => new SabnzbdAdapter(keyed(8080), impl);

    it('treats a 200 with status false as a failure', async () => {
        const impl = (async () => jsonResponse({ status: false, error: 'not implemented' })) as unknown as typeof fetch;
        await expect(adapterWith(impl).setPaused(true)).rejects.toThrow(/not implemented/);
    });

    it('pauses the whole queue with mode=pause and one item by name', async () => {
        const seen: string[] = [];
        const impl = (async (input: string | URL | Request) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            seen.push(url.search);
            return jsonResponse({ status: true });
        }) as unknown as typeof fetch;

        const adapter = adapterWith(impl);
        await adapter.setPaused(true);
        await adapter.setPaused(true, 'SABnzbd_nzo_abc');
        await adapter.setPaused(false);

        expect(seen[0]).toContain('mode=pause');
        expect(seen[1]).toContain('name=pause');
        expect(seen[1]).toContain('value=SABnzbd_nzo_abc');
        expect(seen[2]).toContain('mode=resume');
    });

    // A manual pause of the queue holds every slot but a Force one (`NzbQueue`), and each shows its job's
    // own status, Queued for one waiting its turn. During the wait for post-processing alone, no slot reads
    // Queued, one not paused, fetching, grabbing or checking reads Downloading or Propagating, and the wait
    // holds every slot, Force too (`build_queue`, `Downloader.run`). The first slot is the one read.
    it.each<[boolean, [string, string][], string | undefined]>([
        [true, [['Queued', 'Normal']], 'queue'],
        [true, [['Paused', 'Normal']], 'queue'],
        [true, [['Checking', 'Normal']], 'queue'],
        [true, [['Queued', 'Force']], undefined],
        [true, [['Downloading', 'Force']], undefined],
        [true, [['Downloading', 'Normal']], 'postProcessing'],
        [true, [['Propagating', 'Low']], 'postProcessing'],
        [true, [['Paused', 'Normal'], ['Downloading', 'Normal']], 'postProcessing'],
        [true, [['Downloading', 'Force'], ['Downloading', 'High']], 'postProcessing'],
        [true, [['Queued', 'Normal'], ['Downloading', 'Force']], 'queue'],
        // A job forced during a pause keeps reading Downloading once its priority drops (`set_priority`).
        [true, [['Downloading', 'Normal'], ['Queued', 'Normal']], 'queue'],
        [false, [['Queued', 'Normal']], undefined]
    ])('marks what holds a slot (queue paused %s, slots %j)', async (queuePaused, rows, held) => {
        const slots = rows.map(([status, priority], i) => ({ nzo_id: `SABnzbd_nzo_ab1${i}`, filename: `Some.Film.202${i}`, status, priority }));
        const impl = (async () => jsonResponse({ queue: { paused: queuePaused, slots } })) as unknown as typeof fetch;
        const adapter = adapterWith(impl);
        expect((await adapter.getQueue())[0]?.heldBy).toBe(held);
        expect((await adapter.readPauseState('SABnzbd_nzo_ab10')).heldBy).toBe(held);
    });

    it('reads the queue-level paused flag', async () => {
        const impl = (async () =>
            jsonResponse({ queue: { paused: true, slots: [] } })) as unknown as typeof fetch;
        expect((await adapterWith(impl).readPauseState()).paused).toBe(true);
    });

    // The flag alone, unless the rows show the wait for post-processing (`sabWaiting`): a slot not at Force
    // priority reading Downloading, with none reading Queued, as no slot does under a manual pause.
    it.each<[boolean, [string, string][], { paused: boolean; heldBy?: string }]>([
        [false, [['Queued', 'Normal']], { paused: false }],
        [true, [['Queued', 'Normal']], { paused: true }],
        [true, [['Downloading', 'Force']], { paused: true }],
        [true, [], { paused: true }],
        [true, [['Downloading', 'Normal']], { paused: false, heldBy: 'postProcessing' }],
        [true, [['Downloading', 'Normal'], ['Queued', 'Normal']], { paused: true }]
    ])('reads the whole queue (flag %s, slots %j)', async (queuePaused, rows, state) => {
        const slots = rows.map(([status, priority], i) => ({ nzo_id: `SABnzbd_nzo_ab1${i}`, filename: `Some.Film.202${i}`, status, priority }));
        const impl = (async () => jsonResponse({ queue: { paused: queuePaused, slots } })) as unknown as typeof fetch;
        await expect(adapterWith(impl).readPauseState()).resolves.toEqual({ scope: 'the SABnzbd queue', ...state });
    });
});

describe('qbittorrent pause', () => {
    /** Spec-derived throughout: qBittorrent is not on the stack these were
     *  captured from, so nothing below was confirmed against a live instance. */
    const adapterWith = (impl: typeof fetch) => new QbittorrentAdapter(credential(8081), impl);

    it('falls back to the legacy verb when the v5 one is not there', async () => {
        // v5 renamed pause/resume to stop/start. Both are attempted so one
        // adapter serves 4.x and 5.x, the same way the state map already does.
        const seen: string[] = [];
        const impl = (async (input: string | URL | Request) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.pathname.endsWith('/torrents/info')) return jsonResponse([{ hash: 'abc', state: 'downloading' }]);
            seen.push(url.pathname);
            if (url.pathname.endsWith('/torrents/stop')) return new Response('Not Found', { status: 404 });
            return new Response('', { status: 200 });
        }) as unknown as typeof fetch;

        await adapterWith(impl).setPaused(true, HASH);
        expect(seen.some(u => u.endsWith('/torrents/stop'))).toBe(true);
        expect(seen.some(u => u.endsWith('/torrents/pause'))).toBe(true);
    });

    it('does not call the legacy verb when the v5 one works', async () => {
        const seen: string[] = [];
        const impl = (async (input: string | URL | Request) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.pathname.endsWith('/torrents/info')) return jsonResponse([{ hash: 'abc', state: 'downloading' }]);
            seen.push(url.pathname);
            return new Response('', { status: 200 });
        }) as unknown as typeof fetch;

        await adapterWith(impl).setPaused(true, HASH);
        expect(seen.filter(u => u.endsWith('/torrents/pause'))).toHaveLength(0);
    });

    // qBittorrent reads `hashes` as `|`-separated, with `all` as a keyword, so
    // either would pause more than the preview named.
    it.each(['all', `${HASH}|${'b'.repeat(40)}`, 'abc'])('refuses %j before qBittorrent is called', async id => {
        const seen: string[] = [];
        const impl = (async (input: string | URL | Request) => {
            seen.push(String(input instanceof Request ? input.url : input));
            return jsonResponse([{ hash: HASH, state: 'downloading' }]);
        }) as unknown as typeof fetch;
        await expect(adapterWith(impl).setPaused(true, id)).rejects.toThrow(/info hash/);
        await expect(adapterWith(impl).readPauseState(id)).rejects.toThrow(/info hash/);
        await expect(adapterWith(impl).removeQueueItem(id, { removeFromClient: false, blocklist: false })).rejects.toThrow(
            /info hash/
        );
        expect(seen).toEqual([]);
    });

    it('refuses a hash it cannot find', async () => {
        const impl = (async () => jsonResponse([])) as unknown as typeof fetch;
        await expect(adapterWith(impl).setPaused(true, HASH)).rejects.toThrow(/no torrent/);
    });

    it.each(['pausedDL', 'stoppedUP'])('counts %s as stopped when reading one torrent', async state => {
        const impl = (async () => jsonResponse([{ hash: HASH, state, tags: '' }])) as unknown as typeof fetch;
        expect((await adapterWith(impl).readPauseState(HASH)).paused).toBe(true);
    });

    it('refuses a hash it cannot find when reading state', async () => {
        const impl = (async () => jsonResponse([])) as unknown as typeof fetch;
        await expect(adapterWith(impl).readPauseState(HASH)).rejects.toThrow(/no torrent/);
    });

    it('resumes only the torrents its pause stopped', async () => {
        const fake = qbitFake([
            { hash: 'a'.repeat(40), state: 'stoppedUP', tags: '' },
            { hash: 'b'.repeat(40), state: 'downloading', tags: 'movies' },
            { hash: 'c'.repeat(40), state: 'pausedDL', tags: 'keep' }
        ]);
        const adapter = adapterWith(fake.fetch);

        await adapter.setPaused(true);
        expect(fake.torrents.map(t => [t.state, t.tags])).toEqual([
            ['stoppedUP', ''],
            ['stoppedDL', 'movies, arr-mcp-paused'],
            ['pausedDL', 'keep']
        ]);
        expect((await adapter.readPauseState()).torrents).toEqual({
            running: 0,
            stopped: 3,
            marked: 1,
            mark: 'tag arr-mcp-paused',
            runningIds: [],
            markedIds: ['b'.repeat(40)]
        });

        await adapter.setPaused(false);
        expect(fake.torrents.map(t => [t.state, t.tags])).toEqual([
            ['stoppedUP', ''],
            ['downloading', 'movies'],
            ['pausedDL', 'keep']
        ]);
        expect(fake.sent.every(h => h !== 'all')).toBe(true);
        // No torrent carries the tag any more, so it does not linger in the client's tag list.
        expect(fake.deletedTags).toEqual(['arr-mcp-paused']);
    });

    it('keeps the tag while another torrent still carries it', async () => {
        const fake = qbitFake([
            { hash: 'a'.repeat(40), state: 'stoppedDL', tags: 'arr-mcp-paused' },
            { hash: 'b'.repeat(40), state: 'stoppedDL', tags: 'arr-mcp-paused' }
        ]);
        const adapter = adapterWith(fake.fetch);

        await adapter.setPaused(false, 'a'.repeat(40));
        expect(fake.deletedTags).toEqual([]);
        await adapter.setPaused(false, 'b'.repeat(40));
        expect(fake.deletedTags).toEqual(['arr-mcp-paused']);
    });

    it('leaves its own tag out of the queue facts', async () => {
        const fake = qbitFake([{ hash: HASH, state: 'stoppedDL', tags: 'movies, arr-mcp-paused' }]);
        const [row] = await adapterWith(fake.fetch).getQueue();
        expect(row?.torrent?.tags).toEqual(['movies']);
    });

    it('refuses a whole-client pause on a qBittorrent without tags, before stopping anything', async () => {
        const fake = qbitFake([{ hash: HASH, state: 'downloading' }]);
        await expect(adapterWith(fake.fetch).setPaused(true)).rejects.toThrow(/no torrent tags/);
        expect(fake.torrents[0]?.state).toBe('downloading');
    });
});

type FakeQbit = { hash: string; state: string; tags?: string };

/** An in-memory qBittorrent 5 that applies stop, start and tag writes. */
function qbitFake(torrents: FakeQbit[]) {
    const sent: string[] = [];
    const deletedTags: string[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : String(init?.body ?? ''));
        const verb = url.pathname.split('/').pop();
        if (verb === 'info') {
            const only = url.searchParams.get('hashes');
            const tag = url.searchParams.get('tag');
            return jsonResponse(
                torrents.filter(t => (only === null || t.hash === only) && (tag === null || (t.tags ?? '').split(', ').includes(tag)))
            );
        }
        if (verb === 'deleteTags') {
            deletedTags.push(form.get('tags') ?? '');
            return new Response('', { status: 200 });
        }
        const hashes = form.get('hashes') ?? '';
        sent.push(hashes);
        for (const t of torrents.filter(t => hashes === 'all' || hashes.split('|').includes(t.hash))) {
            const tags = (t.tags ?? '').split(', ').filter(s => s !== '');
            if (verb === 'stop') t.state = t.state.endsWith('UP') || t.state === 'uploading' ? 'stoppedUP' : 'stoppedDL';
            if (verb === 'start') t.state = 'downloading';
            if (verb === 'addTags') t.tags = [...tags, form.get('tags')].join(', ');
            if (verb === 'removeTags') t.tags = tags.filter(s => s !== form.get('tags')).join(', ');
        }
        return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    return { torrents, sent, deletedTags, fetch: impl };
}

describe('qbittorrent pause, continued', () => {

    it('names the qualified instance, not the bare service, when login is refused', async () => {
        const impl = (async (input: string | URL | Request) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.pathname.endsWith('/torrents/info')) return jsonResponse([{ hash: 'abc', state: 'downloading' }]);
            if (url.pathname.endsWith('/auth/login')) return new Response('', { status: 403 });
            return new Response('Forbidden', { status: 403 });
        }) as unknown as typeof fetch;

        const named = new QbittorrentAdapter(
            { ...credential(8081), name: 'vpn', username: 'u', password: 'p' },
            impl
        );
        await expect(named.setPaused(true, HASH)).rejects.toThrow(/qbittorrent\/vpn/);
    });
});

// --- the tool ------------------------------------------------------------

type Call = (args: Record<string, unknown>) => Promise<{
    content: { type: 'text'; text: string }[];
    structuredContent: WriteToolResult;
}>;

/** Shared by `harness`'s default SABnzbd and any test that needs a second,
 *  independently-named one against the same fake queue behaviour. */
function sabFetch(paused: { value: boolean } = { value: false }): typeof fetch {
    return (async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.search.includes('mode=queue')) return jsonResponse({ queue: { paused: paused.value, slots: [] } });
        return jsonResponse({ status: true });
    }) as unknown as typeof fetch;
}

// `instancesOf` deliberately ignores `name` — almost every test here wants a
// single unnamed instance. This reads it when present, so a config built as
// `{ ...keyed(port), name: 'spare' }` produces the qualified id its adapter
// actually carries, without growing that shared helper to cover a case it was
// written to skip.
function harness(
    opts: { adapters?: ServiceAdapter[]; permissions?: Partial<Record<ServiceId, AnyServiceConfig>> } = {}
) {
    const sabPaused = { value: false };
    const adapters = opts.adapters ?? [new SabnzbdAdapter(keyed(8080), sabFetch(sabPaused))];

    let call: Call = () => Promise.reject(new Error('not registered'));
    const server = {
        registerTool(_n: string, config: { inputSchema: z.ZodObject }, handler: Call) {
            call = args => handler(config.inputSchema.parse(args) as Record<string, unknown>);
        }
    };

    const audit = WriteAudit.ephemeral();
    registerPauseDownloads(
        server as never,
        {
            permissions: permissionSourceFrom(
                instancesOf(opts.permissions ?? { sabnzbd: keyed(8080) as unknown as AnyServiceConfig })
            ),
            confirm: new ConfirmTokens(),
            audit,
            library: { invalidate: vi.fn() } as unknown as LibraryLoader
        },
        adapters
    );

    return { call: (a: Record<string, unknown>) => call(a), audit, sabPaused };
}

describe('pause_downloads', () => {
    it('previews without pausing anything', async () => {
        const h = harness();
        const { structuredContent } = await h.call({ service: 'sabnzbd', action: 'pause' });

        expect(structuredContent.applied).toBe(false);
        expect(structuredContent.confirm_token).toBeDefined();
        expect(h.sabPaused.value).toBe(false);
    });

    it('says out loud that the arr queues are not affected', async () => {
        // A model that asked to "pause downloads" and got a bare success has
        // been told something false about Radarr and Sonarr, which keep
        // grabbing regardless.
        const h = harness();
        const { structuredContent } = await h.call({ service: 'sabnzbd', action: 'pause' });

        expect(structuredContent.effects.join(' ')).toContain('Does NOT stop the *arrs searching and grabbing.');
        expect(structuredContent.effects).toContain('Undo it by calling this tool again with action: "resume".');
    });

    // One item paused or resumed leaves the rest of the client as it was, so
    // nothing the *arrs grab meanwhile piles up behind it or starts with it.
    it.each([
        ['pause', 'Queued', /pile up/],
        ['resume', 'Paused', /starts downloading too/]
    ])('leaves the whole-client lines out of a one-item %s', async (action, status, wholeClient) => {
        const slot = { nzo_id: 'SABnzbd_nzo_ab12', filename: 'Some.Film.2026', status };
        const sab = new SabnzbdAdapter(keyed(8080), (async () => jsonResponse({ queue: { paused: false, slots: [slot] } })) as unknown as typeof fetch);
        const { structuredContent } = await harness({ adapters: [sab] }).call({ service: 'sabnzbd', action, id: slot.nzo_id });

        expect(structuredContent.summary).toContain('queue item SABnzbd_nzo_ab12');
        expect(structuredContent.effects.join(' ')).not.toMatch(wholeClient);
        expect(structuredContent.effects.join(' ')).not.toMatch(/\*arrs/);
        if (action === 'pause') expect(structuredContent.effects.join(' ')).toContain('Undo it by calling this tool again with action: "resume" and the same `id`.');
    });

    // A one-item resume does not start a download the paused queue still holds.
    describe('one item under a paused SABnzbd queue', () => {
        // A second slot reading Downloading, not Force, shows the wait for post-processing (`build_queue`).
        const WAITING = { nzo_id: 'SABnzbd_nzo_cd34', filename: 'Other.Film.2025', status: 'Downloading', priority: 'Normal' };
        const run = (status: string, priority: string, opts: { action?: string; others?: object[] } = {}) => {
            const slot = { nzo_id: 'SABnzbd_nzo_ab12', filename: 'Some.Film.2026', status, priority };
            const slots = [slot, ...(opts.others ?? [])];
            const sab = new SabnzbdAdapter(keyed(8080), (async () => jsonResponse({ queue: { paused: true, slots } })) as unknown as typeof fetch);
            return harness({ adapters: [sab] }).call({ service: 'sabnzbd', action: opts.action ?? 'resume', id: slot.nzo_id });
        };
        const POST_PROCESSING = 'sabnzbd pauses its queue while it post-processes ("Pause Downloading During Post-Processing")';
        const STAYS = 'if it stays paused, resume it with this tool and no `id`.';

        it('says the queue holds it after the resume', async () => {
            const { structuredContent } = await run('Paused', 'Normal');
            expect(structuredContent.effects).toEqual([
                "Restarts queue item SABnzbd_nzo_ab12 on sabnzbd. sabnzbd's whole queue is paused too, so it starts downloading only once that is resumed, with this tool and no `id`."
            ]);
        });

        it('says an item that is not paused itself waits on the queue, not that it is running', async () => {
            const { structuredContent } = await run('Queued', 'Normal');
            expect(structuredContent).toMatchObject({
                noop: true,
                summary: "queue item SABnzbd_nzo_ab12 on sabnzbd is not paused itself, but sabnzbd's whole queue is: resume that with this tool and no `id`."
            });
        });

        it('calls a Force item running, since it downloads through a manual pause', async () => {
            const { structuredContent } = await run('Downloading', 'Force');
            expect(structuredContent).toMatchObject({ noop: true, summary: 'queue item SABnzbd_nzo_ab12 on sabnzbd is already running.' });
        });

        it('says the wait for post-processing holds an item that is not paused itself, and ends by itself', async () => {
            const { structuredContent } = await run('Downloading', 'Normal');
            expect(structuredContent).toMatchObject({
                noop: true,
                summary: `queue item SABnzbd_nzo_ab12 on sabnzbd is not paused itself, but ${POST_PROCESSING}, and resumes by itself; ${STAYS}`
            });
        });

        it('says the wait holds a Force item too, since nothing downloads through it', async () => {
            const { structuredContent } = await run('Downloading', 'Force', { others: [WAITING] });
            expect(structuredContent).toMatchObject({
                noop: true,
                summary: `queue item SABnzbd_nzo_ab12 on sabnzbd is not paused itself, but ${POST_PROCESSING}, and resumes by itself; ${STAYS}`
            });
        });

        it('says a resumed item starts once post-processing ends, during the wait', async () => {
            const { structuredContent } = await run('Paused', 'Normal', { others: [WAITING] });
            expect(structuredContent.effects).toEqual([
                `Restarts queue item SABnzbd_nzo_ab12 on sabnzbd. ${POST_PROCESSING}, so it starts downloading once that ends; if the queue stays paused, resume it with this tool and no \`id\`.`
            ]);
        });

        it('calls an item paused itself already paused, whatever holds the queue', async () => {
            const { structuredContent } = await run('Paused', 'Normal', { action: 'pause' });
            expect(structuredContent).toMatchObject({ noop: true, summary: 'queue item SABnzbd_nzo_ab12 on sabnzbd is already paused.' });
        });
    });

    // NZBGet answers a one-item read from `status` and `listgroups`.
    describe('one item on NZBGet', () => {
        const run = (status: Record<string, boolean>, group: Record<string, unknown>, action = 'resume') => {
            const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
                const { method, id } = JSON.parse(String(init?.body)) as { method: string; id: number };
                const result = method === 'listgroups' ? [{ NZBID: 7, NZBNicename: 'Some.Film.2026', FileSizeMB: 10, ...group }] : status;
                return jsonResponse({ jsonrpc: '2.0', result, id });
            }) as unknown as typeof fetch;
            const nzbget = new NzbgetAdapter(credential(6789), fetchImpl);
            return harness({ adapters: [nzbget], permissions: { nzbget: credential(6789) as unknown as AnyServiceConfig } }).call({ service: 'nzbget', action, id: '7' });
        };

        it('says the paused queue holds an item that is not paused itself', async () => {
            const { structuredContent } = await run({ DownloadPaused: true }, { Status: 'QUEUED', RemainingSizeMB: 10, PausedSizeMB: 0 });
            expect(structuredContent).toMatchObject({
                noop: true,
                summary: "queue item 7 on nzbget is not paused itself, but nzbget's whole queue is: resume that with this tool and no `id`."
            });
        });

        // In post-processing NZBGet pauses its spare repair files and unpauses the ones a repair asks for
        // (`RequestMorePars`), so neither action is sent there. The no-op names what else holds it.
        const SPARES = 'NZBGet pauses its spare repair files and unpauses the ones a repair asks for, so this sends nothing.';
        it.each<[string, Record<string, boolean>, Record<string, unknown>, string]>([
            ['resume', {}, { Status: 'REPAIRING', RemainingSizeMB: 2, PausedSizeMB: 2 }, `queue item 7 on nzbget is in post-processing (repairing). ${SPARES}`],
            ['pause', {}, { Status: 'REPAIRING', RemainingSizeMB: 2, PausedSizeMB: 2 }, `queue item 7 on nzbget is in post-processing (repairing). ${SPARES}`],
            // A repair still fetching repair files is not paused either: they are the ones it asked for.
            ['pause', {}, { Status: 'REPAIRING', FileSizeMB: 100, RemainingSizeMB: 40, PausedSizeMB: 25 }, `queue item 7 on nzbget is in post-processing (repairing). ${SPARES}`],
            // `PickNextJob`: paused post-processing starts no job waiting for it.
            [
                'resume',
                { PostPaused: true },
                { Status: 'PP_QUEUED', RemainingSizeMB: 0, PausedSizeMB: 0 },
                `queue item 7 on nzbget is queued for post-processing. ${SPARES} nzbget's post-processing is paused: resume that in nzbget.`
            ],
            // `QueueCoordinator`: a paused queue holds the repair files a repair asked for.
            [
                'resume',
                { DownloadPaused: true, PostPaused: true },
                { Status: 'REPAIRING', FileSizeMB: 100, RemainingSizeMB: 40, PausedSizeMB: 25 },
                `queue item 7 on nzbget is in post-processing (repairing). ${SPARES} nzbget's whole queue is paused, which holds the repair files it asked for: resume that with this tool and no \`id\`. nzbget's post-processing is paused: resume that in nzbget.`
            ]
        ])('sends no %s for an item in post-processing (status %j, group %j)', async (action, status, group, summary) => {
            const { structuredContent } = await run(status, group, action);
            expect(structuredContent).toMatchObject({ noop: true, summary });
        });
    });

    // During the wait for post-processing the rows show (`sabWaiting`), SABnzbd's queue reads as not paused by hand.
    describe('the whole SABnzbd queue while it waits on post-processing', () => {
        const run = (action: string, slots: object[]) => {
            const sab = new SabnzbdAdapter(keyed(8080), (async () => jsonResponse({ queue: { paused: true, slots } })) as unknown as typeof fetch);
            return harness({ adapters: [sab] }).call({ service: 'sabnzbd', action });
        };
        const WAITING = [{ nzo_id: 'SABnzbd_nzo_ab12', filename: 'Some.Film.2026', status: 'Downloading', priority: 'Normal' }];
        const SWITCH = '("Pause Downloading During Post-Processing")';

        it('sends a pause, which keeps the queue paused once the wait ends', async () => {
            const { structuredContent } = await run('pause', WAITING);
            expect(structuredContent.noop).toBe(false);
            expect(structuredContent.confirm_token).toBeDefined();
            expect(structuredContent.effects[0]).toBe(
                `Pauses the SABnzbd queue on sabnzbd by hand. Its rows show it waiting on post-processing ${SWITCH}, after which it would resume by itself; this keeps it paused after.`
            );
        });

        // The rows can hide a manual pause (`sabWaiting`), and a resume does not end the wait.
        it('sends a resume too, and says what starts it if it is only the wait', async () => {
            const { structuredContent } = await run('resume', WAITING);
            expect(structuredContent.confirm_token).toBeDefined();
            expect(structuredContent.effects).toEqual([
                `Restarts the SABnzbd queue on sabnzbd if it is paused by hand. If sabnzbd is only waiting on post-processing ${SWITCH}, as its rows show, this does not end that, and downloading starts once it ends.`,
                'Anything the *arrs grabbed while it was paused starts downloading with it.'
            ]);
        });

        it('calls a queue paused by hand already paused, as before', async () => {
            const { structuredContent } = await run('pause', [{ ...WAITING[0], status: 'Queued' }]);
            expect(structuredContent).toMatchObject({ noop: true, summary: 'the SABnzbd queue on sabnzbd is already paused.' });
        });
    });

    describe('a whole torrent client', () => {
        const torrentHarness = (fake: ReturnType<typeof transmissionFake>) =>
            harness({
                adapters: [new TransmissionAdapter(credential(9091), fake.fetch)],
                permissions: { transmission: credential(9091) as unknown as AnyServiceConfig }
            });

        it('names only the running torrents in a pause preview, and says new ones start', async () => {
            const fake = transmissionFake([
                { id: 1, hashString: hashOf('1'), status: 0, labels: [] },
                { id: 2, hashString: hashOf('2'), status: 4, labels: [] }
            ]);
            const { structuredContent } = await torrentHarness(fake).call({ service: 'transmission', action: 'pause' });

            expect(structuredContent.summary).toBe('Pause the 1 torrent running on transmission.');
            expect(structuredContent.effects).toEqual([
                'Stops them and gives them the label arr-mcp-paused. Nothing already downloaded is lost, and the 1 already stopped stay as they are.',
                'Does NOT stop the *arrs searching and grabbing. A torrent they send meanwhile starts downloading at once.',
                'Undo it by calling this tool again with action: "resume", which starts only the torrents this stopped.'
            ]);
            expect(structuredContent.effects.join(' ')).not.toMatch(/pile up/);
        });

        it('pauses again when an *arr added a torrent after the first pause', async () => {
            const fake = transmissionFake([
                { id: 1, hashString: hashOf('1'), status: 0, labels: ['arr-mcp-paused'] },
                { id: 2, hashString: hashOf('2'), status: 4, labels: [] }
            ]);
            const { structuredContent } = await torrentHarness(fake).call({ service: 'transmission', action: 'pause' });
            expect(structuredContent.confirm_token).toBeDefined();
            expect(structuredContent.summary).toBe('Pause the 1 torrent running on transmission.');
        });

        it.each<[string, FakeTorrent[], string]>([
            ['pause', [{ id: 1, hashString: hashOf('1'), status: 0, labels: [] }], 'No torrent is running on transmission, so there is nothing to pause.'],
            ['pause', [{ id: 1, hashString: hashOf('1'), status: 0, labels: ['arr-mcp-paused'] }], 'transmission is already paused: no torrent is running.'],
            ['resume', [{ id: 1, hashString: hashOf('1'), status: 0, labels: [] }], 'No torrent on transmission has the label arr-mcp-paused a pause sets, so there is nothing to resume. Resume a stopped torrent by its `id`.']
        ])('is a no-op to %s when nothing qualifies (%#)', async (action, torrents, summary) => {
            const { structuredContent } = await torrentHarness(transmissionFake(torrents)).call({ service: 'transmission', action });
            expect(structuredContent.noop).toBe(true);
            expect(structuredContent.summary).toBe(summary);
        });

        it('says a resume starts only the labelled torrents', async () => {
            const fake = transmissionFake([
                { id: 1, hashString: hashOf('1'), status: 0, labels: [] },
                { id: 2, hashString: hashOf('2'), status: 0, labels: ['arr-mcp-paused'] }
            ]);
            const h = torrentHarness(fake);
            const preview = await h.call({ service: 'transmission', action: 'resume' });
            expect(preview.structuredContent.summary).toBe('Resume the 1 torrent paused on transmission.');
            expect(preview.structuredContent.effects.join(' ')).toContain('torrents stopped another way stay stopped');

            await h.call({ service: 'transmission', action: 'resume', confirm: preview.structuredContent.confirm_token });
            expect(fake.torrents.map(t => t.status)).toEqual([0, 4]);
        });

        // A torrent an *arr sends between preview and confirm was never named
        // in the preview, so the token does not stop it.
        it('refuses a pause token once the running torrents changed, and previews the new set', async () => {
            const fake = transmissionFake([{ id: 1, hashString: hashOf('1'), status: 4, labels: [] }]);
            const h = torrentHarness(fake);
            const preview = await h.call({ service: 'transmission', action: 'pause' });

            fake.torrents.push({ id: 2, hashString: hashOf('2'), status: 4, labels: [] });
            const confirmed = await h.call({ service: 'transmission', action: 'pause', confirm: preview.structuredContent.confirm_token });

            expect(confirmed.structuredContent).toMatchObject({ applied: false, summary: 'Pause the 2 torrents running on transmission.' });
            expect(confirmed.structuredContent.confirm_error).toMatch(/changed since that preview/);
            expect(fake.torrents.map(t => t.status)).toEqual([4, 4]);

            await h.call({ service: 'transmission', action: 'pause', confirm: confirmed.structuredContent.confirm_token });
            expect(fake.torrents.map(t => t.status)).toEqual([0, 0]);
        });

        it('refuses a resume for a torrent id the client does not have, rather than calling it running', async () => {
            const fake = transmissionFake([]);
            await expect(torrentHarness(fake).call({ service: 'transmission', action: 'resume', id: hashOf('9') })).rejects.toThrow(/no torrent/);
        });
    });

    it('refuses a limit while Transmission is in turtle mode, which would leave it without effect', async () => {
        const writes: string[] = [];
        const impl = (async (_i: unknown, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body)) as { method: string };
            if (body.method !== 'session-get') writes.push(body.method);
            return rpc({ result: 'success', arguments: { 'alt-speed-enabled': true, 'alt-speed-down': 100 } });
        }) as unknown as typeof fetch;
        const h = harness({
            adapters: [new TransmissionAdapter(credential(9091), impl)],
            permissions: { transmission: credential(9091) as unknown as AnyServiceConfig }
        });

        await expect(h.call({ service: 'transmission', action: 'limit', speed_limit_kbps: 500 })).rejects.toThrow(/turtle mode/);
        expect(writes).toEqual([]);
    });

    it('refuses an empty id', async () => {
        await expect(async () => harness().call({ service: 'sabnzbd', action: 'pause', id: '' })).rejects.toThrow(/too_small|>=1/);
    });

    it('is a no-op when the client is already paused', async () => {
        const h = harness();
        h.sabPaused.value = true;
        const { structuredContent } = await h.call({ service: 'sabnzbd', action: 'pause' });

        expect(structuredContent.noop).toBe(true);
        expect(structuredContent.confirm_token).toBeUndefined();
    });

    it('refuses a configured service that is not a download client', async () => {
        // Radarr *is* configured here, so this is the capability refusal
        // rather than the not-configured one — and it has to name the clients
        // that can be paused, or "radarr cannot be paused" leaves the caller
        // nowhere to go.
        const h = harness({
            adapters: [
                new SabnzbdAdapter(keyed(8080), (async () => jsonResponse({ status: true })) as unknown as typeof fetch),
                new RadarrAdapter(keyed(7878), (async () => jsonResponse({})) as unknown as typeof fetch)
            ]
        });
        await expect(h.call({ service: 'radarr', action: 'pause' })).rejects.toThrow(/sabnzbd|transmission|qbittorrent/i);
    });

    it('names the config key when the permission is off', async () => {
        const off = { ...keyed(8080), permissions: { safe_write: false, destructive: false } };
        const h = harness({ permissions: { sabnzbd: off as unknown as AnyServiceConfig } });
        await expect(h.call({ service: 'sabnzbd', action: 'pause' })).rejects.toThrow(/safe_write/);
    });

    it('refuses a token issued for the opposite action', async () => {
        const h = harness();
        const preview = await h.call({ service: 'sabnzbd', action: 'pause' });
        const swapped = await h.call({
            service: 'sabnzbd',
            action: 'resume',
            confirm: preview.structuredContent.confirm_token
        });

        expect(swapped.structuredContent.applied).toBe(false);
    });

    it('writes an audit row on every branch', async () => {
        const h = harness();
        expect((await h.call({ service: 'sabnzbd', action: 'pause' })).structuredContent.audit_id).toBeDefined();

        const off = { ...keyed(8080), permissions: { safe_write: false, destructive: false } };
        const denied = harness({ permissions: { sabnzbd: off as unknown as AnyServiceConfig } });
        await expect(denied.call({ service: 'sabnzbd', action: 'pause' })).rejects.toThrow();
        expect(denied.audit.recent(10)).toHaveLength(1);
    });

    it('pauses for real once the token comes back', async () => {
        const h = harness();
        const preview = await h.call({ service: 'sabnzbd', action: 'pause' });
        const applied = await h.call({
            service: 'sabnzbd',
            action: 'pause',
            confirm: preview.structuredContent.confirm_token
        });

        expect(applied.structuredContent.applied).toBe(true);
    });

    it('records the instance in the audit target, not the bare service', async () => {
        const spare = { ...keyed(8081), name: 'spare' } as never;
        const h = harness({
            adapters: [new SabnzbdAdapter(spare, sabFetch())],
            permissions: { sabnzbd: spare }
        });

        const preview = await h.call({ service: 'sabnzbd', instance: 'spare', action: 'pause' });
        await h.call({
            service: 'sabnzbd',
            instance: 'spare',
            action: 'pause',
            confirm: preview.structuredContent.confirm_token
        });

        expect(h.audit.recent(10)[0]?.target).toBe('sabnzbd/spare:all');
    });
});
