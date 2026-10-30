import { instancesOf } from './helpers/instances.ts';
import { describe, expect, it, vi } from 'vitest';
import type * as z from 'zod/v4';
import type { AnyServiceConfig, KeyedServiceConfig } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import { SabnzbdAdapter } from '../src/services/sabnzbd.ts';
import type { DownloadTrace, RetryOutcome, RetryTarget, ServiceAdapter } from '../src/services/types.ts';
import type { LibraryLoader } from '../src/tools/library.ts';
import { registerRetryDownload } from '../src/tools/retryDownload.ts';
import type { WriteToolResult } from '../src/tools/write.ts';
import { jsonResponse } from './helpers/serve.ts';

/**
 * The tool, over adapters whose retry and trace calls are stubbed: the
 * adapters' own HTTP behaviour is covered in their own tests, and what matters
 * here is what the preview promises and what never leaks.
 */

const keyed = (port: number): KeyedServiceConfig => ({
    url: `http://192.0.2.10:${port}`,
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: true, destructive: false }
});

const unused = (async () => jsonResponse({})) as unknown as typeof fetch;

const FAILED: RetryTarget = {
    id: 'SABnzbd_nzo_abc',
    title: 'Some.Movie.2020.1080p',
    where: 'history',
    status: 'Failed',
    reason: 'Unpacking failed, archive requires a password',
    downloadId: 'SABnzbd_nzo_abc',
    method: 'retry'
};

type Call = (args: Record<string, unknown>) => Promise<{
    content: { type: 'text'; text: string }[];
    structuredContent: WriteToolResult;
}>;

function harness(opts: { trace?: () => Promise<DownloadTrace | undefined>; target?: RetryTarget } = {}) {
    const sab = new SabnzbdAdapter(keyed(8080), unused);
    const radarr = new RadarrAdapter(keyed(7878), unused);

    const find = vi.spyOn(sab, 'findRetryTarget').mockResolvedValue(opts.target ?? FAILED);
    const outcome: RetryOutcome = {
        target: opts.target ?? FAILED,
        id: 'SABnzbd_nzo_new',
        state: 'downloading',
        status: 'Downloading'
    };
    const run = vi.spyOn(sab, 'runRetry').mockResolvedValue(outcome);
    const trace = vi.spyOn(radarr, 'traceDownload').mockImplementation(opts.trace ?? (async () => undefined));

    const adapters: ServiceAdapter[] = [sab, radarr];

    let call: Call = () => Promise.reject(new Error('not registered'));
    const server = {
        registerTool(_n: string, config: { inputSchema: z.ZodObject }, handler: Call) {
            call = args => handler(config.inputSchema.parse(args) as Record<string, unknown>);
        }
    };

    const audit = WriteAudit.ephemeral();
    registerRetryDownload(
        server as never,
        {
            permissions: permissionSourceFrom(
                instancesOf({
                    sabnzbd: keyed(8080) as unknown as AnyServiceConfig,
                    radarr: keyed(7878) as unknown as AnyServiceConfig
                })
            ),
            confirm: new ConfirmTokens(),
            audit,
            library: { invalidate: vi.fn() } as unknown as LibraryLoader
        },
        adapters
    );

    return { call: (a: Record<string, unknown>) => call(a), audit, find, run, trace };
}

describe('retry_download', () => {
    it('previews a SABnzbd failed job without sending a retry', async () => {
        const h = harness();
        const { structuredContent } = await h.call({ service: 'sabnzbd', id: 'SABnzbd_nzo_abc' });

        expect(structuredContent.applied).toBe(false);
        expect(structuredContent.confirm_token).toBeDefined();
        expect(structuredContent.target).toBe('sabnzbd:retry/SABnzbd_nzo_abc');
        expect(structuredContent.effects.join(' ')).toContain('Some.Movie.2020.1080p');
        expect(structuredContent.effects.join(' ')).toMatch(/whisparr and lidarr are not checked/i);
        expect(h.find).toHaveBeenCalledWith('SABnzbd_nzo_abc', { hasPassword: false });
        expect(h.run).not.toHaveBeenCalled();
    });

    it('warns when Radarr already imported a replacement', async () => {
        const h = harness({
            trace: async () => ({
                service: 'radarr',
                title: 'Some.Movie.2020.1080p',
                failedAt: '2026-10-29T10:00:00Z',
                replacement: { title: 'Some.Movie.2020.2160p', grabbedAt: '2026-10-29T11:00:00Z', imported: true }
            })
        });
        const { structuredContent } = await h.call({ service: 'sabnzbd', id: 'SABnzbd_nzo_abc' });

        expect(h.trace).toHaveBeenCalledWith('SABnzbd_nzo_abc');
        const effects = structuredContent.effects.join(' ');
        expect(effects).toMatch(/two copies/);
        expect(effects).toContain('Some.Movie.2020.2160p');
        expect(effects).toMatch(/imported/);
    });

    it('still previews when Radarr cannot be reached, and says it could not check', async () => {
        const h = harness({
            trace: async () => {
                throw new Error('ECONNREFUSED');
            }
        });
        const { structuredContent } = await h.call({ service: 'sabnzbd', id: 'SABnzbd_nzo_abc' });

        expect(structuredContent.confirm_token).toBeDefined();
        const effects = structuredContent.effects.join(' ');
        expect(effects).toMatch(/could not check radarr/i);
        expect(effects).not.toMatch(/no replacement/i);
    });

    it('never shows the password', async () => {
        const h = harness();
        const preview = await h.call({ service: 'sabnzbd', id: 'SABnzbd_nzo_abc', password: 'hunter2' });
        expect(h.find).toHaveBeenCalledWith('SABnzbd_nzo_abc', { hasPassword: true });
        expect(preview.structuredContent.effects.join(' ')).toMatch(/a password will be used/i);

        const applied = await h.call({
            service: 'sabnzbd',
            id: 'SABnzbd_nzo_abc',
            password: 'hunter2',
            confirm: preview.structuredContent.confirm_token
        });

        expect(applied.structuredContent.applied).toBe(true);
        expect(h.run).toHaveBeenCalledWith('SABnzbd_nzo_abc', { method: 'retry', password: 'hunter2' });

        const rows = h.audit.recent(10);
        for (const shown of [preview, applied, rows]) {
            expect(JSON.stringify(shown)).not.toContain('hunter2');
        }
        expect(JSON.stringify(rows)).toContain('__REDACTED__');
    });

    it('refuses a service that cannot retry', async () => {
        const h = harness();
        await expect(h.call({ service: 'radarr', id: '5' })).rejects.toThrow(/sabnzbd and nzbget/);
    });

    it('a different password needs a new preview', async () => {
        const h = harness();
        const preview = await h.call({ service: 'sabnzbd', id: 'SABnzbd_nzo_abc', password: 'a' });
        const swapped = await h.call({
            service: 'sabnzbd',
            id: 'SABnzbd_nzo_abc',
            password: 'b',
            confirm: preview.structuredContent.confirm_token
        });

        expect(swapped.structuredContent.applied).toBe(false);
        expect(swapped.structuredContent.confirm_error).toBeDefined();
        expect(h.run).not.toHaveBeenCalled();
    });

    it('says a finished rerun with no event is gone from the client, not that it failed', async () => {
        const target: RetryTarget = { ...FAILED, method: 'postprocess' };
        const h = harness({ target });
        h.run.mockResolvedValue({ target, id: FAILED.id, state: 'finished', status: 'removed' });

        const preview = await h.call({ service: 'sabnzbd', id: 'SABnzbd_nzo_abc' });
        expect(preview.structuredContent.effects.join(' ')).toMatch(/no password will be supplied/i);

        const applied = await h.call({
            service: 'sabnzbd',
            id: 'SABnzbd_nzo_abc',
            confirm: preview.structuredContent.confirm_token
        });
        expect(applied.content[0]?.text).toMatch(/no longer in .*history/i);
    });

    it('warns that a URL-added SABnzbd job may lose the password on retry', async () => {
        const h = harness();
        const { structuredContent } = await h.call({ service: 'sabnzbd', id: 'SABnzbd_nzo_abc', password: 'x' });
        expect(structuredContent.effects.join(' ')).toMatch(/added from a URL/);
    });
});
