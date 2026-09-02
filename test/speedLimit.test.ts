import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';
import type { AnyServiceConfig, CredentialServiceConfig, KeyedServiceConfig } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import { QbittorrentAdapter } from '../src/services/qbittorrent.ts';
import { SabnzbdAdapter } from '../src/services/sabnzbd.ts';
import { TransmissionAdapter } from '../src/services/transmission.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import type { LibraryLoader } from '../src/tools/library.ts';
import { registerPauseDownloads } from '../src/tools/pauseDownloads.ts';
import type { WriteToolResult } from '../src/tools/write.ts';
import { instancesOf } from './helpers/instances.ts';
import { jsonResponse } from './helpers/serve.ts';

/**
 * Every client speaks a different unit here, and the wrong one throttles a
 * stack to nothing: SABnzbd reads a bare number as a *percentage*,
 * qBittorrent wants bytes/s, Transmission wants KB/s. These pin the wire
 * format, not just the call.
 */

const sabConfig: KeyedServiceConfig = {
    url: 'http://192.0.2.10:8080',
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: true, destructive: false }
};

const clientConfig: CredentialServiceConfig = {
    url: 'http://192.0.2.10:9091',
    timeout_ms: 10_000,
    permissions: { safe_write: true, destructive: false }
};

function recording(handler: (url: URL, init?: RequestInit) => unknown) {
    const sent: { path: string; search: string; method: string; body: string | undefined }[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        sent.push({
            path: url.pathname,
            search: url.search,
            method: init?.method ?? 'GET',
            body: typeof init?.body === 'string' ? init.body : undefined
        });
        return handler(url, init);
    }) as unknown as typeof fetch;
    return { impl, sent };
}

describe('SABnzbd speed limit', () => {
    it('reads the absolute limit, not the percentage beside it', async () => {
        const { impl } = recording(() => jsonResponse({ queue: { speedlimit_abs: '5242880', speedlimit: '50' } }));
        expect(await new SabnzbdAdapter(sabConfig, impl).readSpeedLimit()).toEqual({
            service: 'sabnzbd',
            kbps: 5120
        });
    });

    it('reports no limit when the absolute value is zero', async () => {
        const { impl } = recording(() => jsonResponse({ queue: { speedlimit_abs: '0' } }));
        expect(await new SabnzbdAdapter(sabConfig, impl).readSpeedLimit()).toEqual({ service: 'sabnzbd' });
    });

    /** A bare `value=100` is 100 *percent* of the configured line speed. */
    it('sends the K suffix, which is what makes it KB/s rather than a percentage', async () => {
        const { impl, sent } = recording(() => jsonResponse({ status: true }));
        await new SabnzbdAdapter(sabConfig, impl).setSpeedLimit(2000);
        expect(sent.at(-1)?.search).toContain('value=2000K');
    });

    it('clears the cap with zero', async () => {
        const { impl, sent } = recording(() => jsonResponse({ status: true }));
        await new SabnzbdAdapter(sabConfig, impl).setSpeedLimit(undefined);
        expect(sent.at(-1)?.search).toContain('value=0');
    });

    /** SABnzbd answers 200 with `status: false` when it refuses. */
    it('treats a 200 with status false as a failure', async () => {
        const { impl } = recording(() => jsonResponse({ status: false, error: 'nope' }));
        await expect(new SabnzbdAdapter(sabConfig, impl).setSpeedLimit(100)).rejects.toThrow(/nope/);
    });
});

describe('Transmission speed limit', () => {
    it('reads KB/s, and only when the enabled flag is set', async () => {
        const enabled = recording(() =>
            jsonResponse({ result: 'success', arguments: { 'speed-limit-down': 500, 'speed-limit-down-enabled': true } })
        );
        expect(await new TransmissionAdapter(clientConfig, enabled.impl).readSpeedLimit()).toEqual({
            service: 'transmission',
            kbps: 500
        });

        const disabled = recording(() =>
            jsonResponse({ result: 'success', arguments: { 'speed-limit-down': 500, 'speed-limit-down-enabled': false } })
        );
        expect(await new TransmissionAdapter(clientConfig, disabled.impl).readSpeedLimit()).toEqual({
            service: 'transmission'
        });
    });

    it('sets the number and the flag together', async () => {
        const { impl, sent } = recording(() => jsonResponse({ result: 'success' }));
        await new TransmissionAdapter(clientConfig, impl).setSpeedLimit(500);
        expect(JSON.parse(sent.at(-1)?.body ?? '{}')).toMatchObject({
            method: 'session-set',
            arguments: { 'speed-limit-down': 500, 'speed-limit-down-enabled': true }
        });
    });

    /** Transmission keeps the number behind the flag, so a stale cap would
     *  come back the next time anything enabled it. */
    it('zeroes the number when clearing, not just the flag', async () => {
        const { impl, sent } = recording(() => jsonResponse({ result: 'success' }));
        await new TransmissionAdapter(clientConfig, impl).setSpeedLimit(undefined);
        expect(JSON.parse(sent.at(-1)?.body ?? '{}')).toMatchObject({
            arguments: { 'speed-limit-down': 0, 'speed-limit-down-enabled': false }
        });
    });

    it('treats a non-success result as a failure', async () => {
        const { impl } = recording(() => jsonResponse({ result: 'no such session' }));
        await expect(new TransmissionAdapter(clientConfig, impl).setSpeedLimit(100)).rejects.toThrow(/session-set/);
    });
});

describe('qBittorrent speed limit', () => {
    it('converts bytes per second to KB/s on the way in', async () => {
        const { impl } = recording(() => new Response('512000', { status: 200 }));
        expect(await new QbittorrentAdapter(clientConfig, impl).readSpeedLimit()).toEqual({
            service: 'qbittorrent',
            kbps: 500
        });
    });

    it('sends bytes per second on the way out', async () => {
        const { impl, sent } = recording(() => new Response('', { status: 200 }));
        await new QbittorrentAdapter(clientConfig, impl).setSpeedLimit(500);
        expect(sent.at(-1)?.body).toContain('limit=512000');
    });

    it('sends zero to clear, which qBittorrent reads as unlimited', async () => {
        const { impl, sent } = recording(() => new Response('', { status: 200 }));
        await new QbittorrentAdapter(clientConfig, impl).setSpeedLimit(undefined);
        expect(sent.at(-1)?.body).toContain('limit=0');
    });
});

type Call = (args: Record<string, unknown>) => Promise<{
    content: { type: 'text'; text: string }[];
    structuredContent: WriteToolResult;
}>;

function harness(adapter: ServiceAdapter) {
    let call: Call = () => Promise.reject(new Error('not registered'));
    const server = {
        registerTool(_n: string, config: { inputSchema: z.ZodObject }, handler: Call) {
            call = args => handler(config.inputSchema.parse(args) as Record<string, unknown>);
        }
    };

    registerPauseDownloads(
        server as never,
        {
            permissions: permissionSourceFrom(
                instancesOf({ sabnzbd: { ...sabConfig } as AnyServiceConfig })
            ),
            confirm: new ConfirmTokens(),
            audit: WriteAudit.ephemeral(),
            library: { invalidate: vi.fn() } as unknown as LibraryLoader
        },
        [adapter]
    );

    return (args: Record<string, unknown>) => call(args);
}

describe('pause_downloads limit', () => {
    const sab = (queue: unknown, onWrite: (url: URL) => unknown = () => jsonResponse({ status: true })) => {
        const seen: string[] = [];
        const impl = (async (input: string | URL | Request) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            seen.push(url.search);
            if (url.search.includes('mode=config')) return onWrite(url);
            return jsonResponse(queue);
        }) as unknown as typeof fetch;
        return { adapter: new SabnzbdAdapter(sabConfig, impl), seen };
    };

    it('names the cap it is setting and what it is coming from', async () => {
        const { adapter } = sab({ queue: { speedlimit_abs: '5242880' } });
        const { structuredContent } = await harness(adapter)({
            service: 'sabnzbd',
            action: 'limit',
            speed_limit_kbps: 1000,
            dry_run: true
        });

        expect(structuredContent.summary).toContain('1000 KB/s');
        expect(structuredContent.effects.join(' ')).toContain('5120 KB/s');
    });

    it('says the *arrs keep grabbing regardless', async () => {
        const { adapter } = sab({ queue: {} });
        const { structuredContent } = await harness(adapter)({
            service: 'sabnzbd',
            action: 'limit',
            speed_limit_kbps: 1000,
            dry_run: true
        });
        expect(structuredContent.effects.join(' ')).toMatch(/does not stop radarr or sonarr/i);
    });

    it('is a no-op when the cap already matches', async () => {
        const { adapter } = sab({ queue: { speedlimit_abs: '1024000' } });
        const { structuredContent } = await harness(adapter)({
            service: 'sabnzbd',
            action: 'limit',
            speed_limit_kbps: 1000
        });
        expect(structuredContent.noop).toBe(true);
    });

    it('needs a value', async () => {
        const { adapter } = sab({ queue: {} });
        await expect(harness(adapter)({ service: 'sabnzbd', action: 'limit', dry_run: true })).rejects.toThrow(
            /speed_limit_kbps/
        );
    });

    it('applies the cap only after confirmation', async () => {
        const { adapter, seen } = sab({ queue: {} });
        const call = harness(adapter);

        const first = await call({ service: 'sabnzbd', action: 'limit', speed_limit_kbps: 1000 });
        expect(seen.some(s => s.includes('mode=config'))).toBe(false);

        const second = await call({
            service: 'sabnzbd',
            action: 'limit',
            speed_limit_kbps: 1000,
            confirm: first.structuredContent.confirm_token
        });
        expect(second.structuredContent.applied).toBe(true);
        expect(seen.some(s => s.includes('value=1000K'))).toBe(true);
    });

    it('refuses on a service with no limit to set', async () => {
        const arr = {
            id: 'radarr',
            type: 'radarr',
            testConnection: async () => ({ ok: true, service: 'radarr', latency_ms: 1 }),
            getVersion: async () => '5.0'
        } as unknown as ServiceAdapter;

        await expect(
            harness(arr)({ service: 'radarr', action: 'limit', speed_limit_kbps: 10, dry_run: true })
        ).rejects.toThrow(/cannot be paused|no download speed limit/i);
    });
});
