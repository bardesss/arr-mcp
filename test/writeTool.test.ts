import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';
import type { AnyServiceConfig, ServiceId } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { ServiceError } from '../src/core/errors.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import type { LibraryLoader } from '../src/tools/library.ts';
import { registerWriteTool, type WritePlan, type WriteToolResult } from '../src/tools/write.ts';

/**
 * A stand-in for McpServer that keeps the one behaviour the harness depends on:
 * arguments are parsed against the declared schema — including its defaults —
 * before the handler sees them. A fake that skipped the parse would hide the
 * fact that `dry_run` gets its `false` from the schema.
 */
type Handler = (args: Record<string, unknown>) => Promise<{
    content: { type: 'text'; text: string }[];
    structuredContent: WriteToolResult;
}>;

function fakeServer() {
    const tools = new Map<string, { schema: z.ZodObject; handler: Handler }>();
    const server = {
        registerTool(name: string, config: { inputSchema: z.ZodObject }, handler: Handler) {
            tools.set(name, { schema: config.inputSchema, handler });
        }
    };

    const call = async (name: string, args: Record<string, unknown> = {}) => {
        const tool = tools.get(name);
        if (tool === undefined) throw new Error(`no such tool: ${name}`);
        return tool.handler(tool.schema.parse(args) as Record<string, unknown>);
    };

    return { server: server as never, call, tools };
}

const service = (safe_write: boolean, destructive: boolean): AnyServiceConfig =>
    ({
        url: 'http://192.0.2.10:7878',
        api_key: 'k',
        timeout_ms: 10_000,
        permissions: { safe_write, destructive }
    }) as AnyServiceConfig;

const PLAN: WritePlan = {
    target: '5',
    summary: 'Delete Alien (1979) from Radarr, deleting files from disk.',
    effects: ['Deletes 1 file totalling 24.1 GB from disk.', 'Removes the film from Radarr.'],
    args: { deleteFiles: true }
};

type Harness = ReturnType<typeof buildHarness>;

function buildHarness(
    opts: {
        permissions?: Partial<Record<ServiceId, AnyServiceConfig>>;
        plan?: WritePlan;
        apply?: () => Promise<unknown>;
        tier?: 'safe' | 'destructive';
    } = {}
) {
    const audit = WriteAudit.ephemeral();
    const confirm = new ConfirmTokens();
    const invalidate = vi.fn();
    const apply = vi.fn(opts.apply ?? (() => Promise.resolve({ ok: true })));
    const plan = vi.fn(() => Promise.resolve(opts.plan ?? PLAN));

    const { server, call } = fakeServer();
    registerWriteTool(
        server,
        {
            permissions: permissionSourceFrom(opts.permissions ?? { radarr: service(false, true) }),
            confirm,
            audit,
            library: { invalidate } as unknown as LibraryLoader
        },
        {
            name: 'delete_media',
            description: 'Deletes a film.',
            inputSchema: z.object({ id: z.string() }),
            service: 'radarr',
            operation: 'delete_movie',
            tier: opts.tier ?? 'destructive',
            plan,
            apply
        }
    );

    return { audit, call, apply, plan, invalidate };
}

const outcomes = (h: Harness): string[] =>
    (h.audit.recent() as { outcome: string }[]).map(r => r.outcome).reverse();

let harness: Harness;
beforeEach(() => {
    harness = buildHarness();
});

describe('write tool harness — preview and confirm', () => {
    it('does not apply anything on the first call, and returns a token', async () => {
        const { structuredContent } = await harness.call('delete_media', { id: '5' });

        expect(structuredContent.applied).toBe(false);
        expect(structuredContent.confirm_token).toBeTypeOf('string');
        expect(harness.apply).not.toHaveBeenCalled();
    });

    it('applies once the token from that preview comes back', async () => {
        const first = await harness.call('delete_media', { id: '5' });
        const second = await harness.call('delete_media', {
            id: '5',
            confirm: first.structuredContent.confirm_token
        });

        expect(second.structuredContent.applied).toBe(true);
        expect(second.structuredContent.result).toEqual({ ok: true });
        expect(harness.apply).toHaveBeenCalledTimes(1);
    });

    it('tells the model exactly how to apply it', async () => {
        const { content } = await harness.call('delete_media', { id: '5' });
        expect(content[0]?.text).toContain('confirm');
        expect(content[0]?.text).toContain('delete_media');
    });

    it('refuses to apply the same token twice', async () => {
        const first = await harness.call('delete_media', { id: '5' });
        const token = first.structuredContent.confirm_token;

        await harness.call('delete_media', { id: '5', confirm: token });
        await expect(harness.call('delete_media', { id: '5', confirm: token })).rejects.toThrow(/already used/);
        expect(harness.apply).toHaveBeenCalledTimes(1);
    });

    // A rejected-but-not-spent token is a caller mistake with no risk of a
    // double-apply, so it degrades to a normal preview carrying the reason —
    // more useful than an error the model then has to work backwards from.
    it('returns a fresh preview, not an error, when the token is simply wrong', async () => {
        const { structuredContent } = await harness.call('delete_media', { id: '5', confirm: 'nonsense' });

        expect(structuredContent.applied).toBe(false);
        expect(structuredContent.confirm_error).toBeTypeOf('string');
        expect(structuredContent.confirm_token).toBeTypeOf('string');
        expect(harness.apply).not.toHaveBeenCalled();
    });

    it('lets the fresh token from a rejection be used', async () => {
        const rejected = await harness.call('delete_media', { id: '5', confirm: 'nonsense' });
        const applied = await harness.call('delete_media', {
            id: '5',
            confirm: rejected.structuredContent.confirm_token
        });
        expect(applied.structuredContent.applied).toBe(true);
    });
});

describe('write tool harness — dry_run', () => {
    it('describes the effect and changes nothing', async () => {
        const { structuredContent, content } = await harness.call('delete_media', { id: '5', dry_run: true });

        expect(structuredContent.applied).toBe(false);
        expect(structuredContent.dry_run).toBe(true);
        expect(structuredContent.effects).toEqual(PLAN.effects);
        expect(content[0]?.text).toContain('nothing was changed');
        expect(harness.apply).not.toHaveBeenCalled();
    });

    // Issuing one would blur the two mechanisms: dry_run answers "what would
    // happen", the handshake is for when you mean to do it.
    it('issues no token, so a dry run cannot become a write', async () => {
        const { structuredContent } = await harness.call('delete_media', { id: '5', dry_run: true });
        expect(structuredContent.confirm_token).toBeUndefined();
    });

    // Refusing it would withhold nothing — everything in a preview is already
    // reachable through the read tools — while making "what would I need to
    // enable?" unanswerable.
    it('still previews when the tier is off, and says the write would be refused', async () => {
        const denied = buildHarness({ permissions: { radarr: service(false, false) } });
        const { structuredContent, content } = await denied.call('delete_media', { id: '5', dry_run: true });

        expect(structuredContent.permission.allowed).toBe(false);
        expect(structuredContent.permission.remedy).toContain('permissions.destructive: true');
        expect(content[0]?.text).toContain('would currently be refused');
    });
});

describe('write tool harness — permission tiers', () => {
    it('refuses a live write when the tier is off, before touching the service', async () => {
        const denied = buildHarness({ permissions: { radarr: service(false, false) } });

        await expect(denied.call('delete_media', { id: '5' })).rejects.toThrow(ServiceError);
        expect(denied.apply).not.toHaveBeenCalled();
    });

    it('names the YAML key in the refusal', async () => {
        const denied = buildHarness({ permissions: { radarr: service(false, false) } });
        await expect(denied.call('delete_media', { id: '5' })).rejects.toThrow(
            /services\.radarr\.permissions\.destructive: true/
        );
    });

    it('refuses before issuing a token, so a denial cannot be confirmed around', async () => {
        const denied = buildHarness({ permissions: { radarr: service(true, false) } });
        await expect(denied.call('delete_media', { id: '5' })).rejects.toThrow(ServiceError);
        expect(outcomes(denied)).toEqual(['denied']);
    });

    it('lets a safe-tier tool through on safe_write alone', async () => {
        const safe = buildHarness({ tier: 'safe', permissions: { radarr: service(true, false) } });
        const first = await safe.call('delete_media', { id: '5' });
        expect(first.structuredContent.confirm_token).toBeTypeOf('string');
    });
});

describe('write tool harness — no-op plans', () => {
    const noopPlan: WritePlan = {
        target: '5',
        summary: 'Alien (1979) is already unmonitored in Radarr.',
        effects: [],
        noop: true
    };

    it('short-circuits without asking for a confirmation nobody needs', async () => {
        const noop = buildHarness({ plan: noopPlan });
        const { structuredContent, content } = await noop.call('delete_media', { id: '5' });

        expect(structuredContent.applied).toBe(false);
        expect(structuredContent.noop).toBe(true);
        expect(structuredContent.confirm_token).toBeUndefined();
        expect(content[0]?.text).toContain('Nothing to do');
        expect(noop.apply).not.toHaveBeenCalled();
    });
});

describe('write tool harness — the audit trail', () => {
    it('records a preview, then the write it turned into', async () => {
        const first = await harness.call('delete_media', { id: '5' });
        await harness.call('delete_media', { id: '5', confirm: first.structuredContent.confirm_token });

        expect(outcomes(harness)).toEqual(['unconfirmed', 'applied']);
    });

    it('records a dry run', async () => {
        await harness.call('delete_media', { id: '5', dry_run: true });
        expect(outcomes(harness)).toEqual(['dry_run']);
    });

    it('records a write the service refused, with the reason', async () => {
        const failing = buildHarness({
            apply: () => Promise.reject(new ServiceError('UpstreamError', 'radarr', 'HTTP 500 at /api/v3/movie/5'))
        });
        const first = await failing.call('delete_media', { id: '5' });

        await expect(
            failing.call('delete_media', { id: '5', confirm: first.structuredContent.confirm_token })
        ).rejects.toThrow(ServiceError);

        const rows = failing.audit.recent() as { outcome: string; detail: string | null }[];
        expect(rows[0]?.outcome).toBe('failed');
        expect(rows[0]?.detail).toContain('HTTP 500');
    });

    it('records the resolved target, not the argument the caller typed', async () => {
        const resolving = buildHarness({ plan: { ...PLAN, target: 'radarr:5' } });
        await resolving.call('delete_media', { id: 'Alien', dry_run: true });

        const [row] = resolving.audit.recent() as { target: string }[];
        expect(row?.target).toBe('radarr:5');
    });
});

describe('write tool harness — cache invalidation', () => {
    it('drops the library cache after a write that landed (§16)', async () => {
        const first = await harness.call('delete_media', { id: '5' });
        await harness.call('delete_media', { id: '5', confirm: first.structuredContent.confirm_token });
        expect(harness.invalidate).toHaveBeenCalledTimes(1);
    });

    it('does not drop it for a preview or a dry run', async () => {
        await harness.call('delete_media', { id: '5' });
        await harness.call('delete_media', { id: '5', dry_run: true });
        expect(harness.invalidate).not.toHaveBeenCalled();
    });

    it('does not drop it when the write failed and changed nothing', async () => {
        const failing = buildHarness({ apply: () => Promise.reject(new Error('nope')) });
        const first = await failing.call('delete_media', { id: '5' });
        await expect(
            failing.call('delete_media', { id: '5', confirm: first.structuredContent.confirm_token })
        ).rejects.toThrow();
        expect(failing.invalidate).not.toHaveBeenCalled();
    });
});

describe('write tool harness — argument binding', () => {
    it('will not let a token previewed for one target apply to another', async () => {
        // Two tools over one harness would be closer to the real thing, but the
        // binding is per-plan: re-planning to a different target must invalidate
        // a token issued for the first.
        const first_plan: WritePlan = { ...PLAN, target: '5' };
        const second_plan: WritePlan = { ...PLAN, target: '9' };

        let called = false;
        const shifting = buildHarness({ plan: first_plan });
        shifting.plan.mockImplementation(() => {
            const next = called ? second_plan : first_plan;
            called = true;
            return Promise.resolve(next);
        });

        const first = await shifting.call('delete_media', { id: '5' });
        const second = await shifting.call('delete_media', {
            id: '9',
            confirm: first.structuredContent.confirm_token
        });

        expect(second.structuredContent.applied).toBe(false);
        expect(second.structuredContent.confirm_error).toContain('different operation');
        expect(shifting.apply).not.toHaveBeenCalled();
    });
});
