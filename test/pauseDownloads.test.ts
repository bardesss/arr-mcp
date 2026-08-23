import { instancesOf } from './helpers/instances.ts';
import { describe, expect, it, vi } from 'vitest';
import type * as z from 'zod/v4';
import type { AnyServiceConfig, CredentialServiceConfig, KeyedServiceConfig, ServiceId } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
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

// --- adapters ------------------------------------------------------------

describe('transmission pause', () => {
    const adapterWith = (impl: typeof fetch) => new TransmissionAdapter(credential(9091), impl);

    it('treats a 200 with a non-success result as a failure', async () => {
        // Every Transmission failure arrives as HTTP 200. Trusting the status
        // line would report a pause that never happened.
        const impl = (async () => rpc({ result: 'no such torrent' })) as unknown as typeof fetch;
        await expect(adapterWith(impl).setPaused(true)).rejects.toThrow(/no such torrent/);
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

    it('reads the whole client as paused only when every torrent is stopped', async () => {
        const withStatuses = (statuses: number[]) =>
            adapterWith(
                (async () =>
                    rpc({
                        result: 'success',
                        arguments: { torrents: statuses.map((status, id) => ({ id, status })) }
                    })) as unknown as typeof fetch
            );

        expect((await withStatuses([0, 0]).readPauseState()).paused).toBe(true);
        expect((await withStatuses([0, 4]).readPauseState()).paused).toBe(false);
        // Nothing to pause is not "paused" — it is nothing to pause.
        expect((await withStatuses([]).readPauseState()).paused).toBe(false);
    });
});

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

    it('reads the queue-level paused flag', async () => {
        const impl = (async () =>
            jsonResponse({ queue: { paused: true, slots: [] } })) as unknown as typeof fetch;
        expect((await adapterWith(impl).readPauseState()).paused).toBe(true);
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

        await adapterWith(impl).setPaused(true, 'abc');
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

        await adapterWith(impl).setPaused(true, 'abc');
        expect(seen.filter(u => u.endsWith('/torrents/pause'))).toHaveLength(0);
    });

    it('refuses a hash it cannot find', async () => {
        const impl = (async () => jsonResponse([])) as unknown as typeof fetch;
        await expect(adapterWith(impl).setPaused(true, 'abc')).rejects.toThrow(/no torrent/);
    });

    it('counts both spellings of stopped when reading state', async () => {
        const impl = (async () =>
            jsonResponse([{ hash: 'a', state: 'pausedDL' }, { hash: 'b', state: 'stoppedUP' }])) as unknown as typeof fetch;
        expect((await adapterWith(impl).readPauseState()).paused).toBe(true);
    });
});

// --- the tool ------------------------------------------------------------

type Call = (args: Record<string, unknown>) => Promise<{
    content: { type: 'text'; text: string }[];
    structuredContent: WriteToolResult;
}>;

function harness(
    opts: { adapters?: ServiceAdapter[]; permissions?: Partial<Record<ServiceId, AnyServiceConfig>> } = {}
) {
    const sabPaused = { value: false };
    const sabImpl = (async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.search.includes('mode=queue')) return jsonResponse({ queue: { paused: sabPaused.value, slots: [] } });
        return jsonResponse({ status: true });
    }) as unknown as typeof fetch;

    const adapters = opts.adapters ?? [new SabnzbdAdapter(keyed(8080), sabImpl)];

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

        expect(structuredContent.effects.join(' ')).toMatch(/radarr|sonarr/i);
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
});
