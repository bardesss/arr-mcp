import { instancesOf } from './helpers/instances.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';
import type { AnyServiceConfig, ServiceId } from '../src/config/schema.ts';
import { BEARER_CALLER, WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { ServiceError } from '../src/core/errors.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import type { LibraryLoader } from '../src/tools/library.ts';
import type { CrossChecker, CrossCheckProfile } from '../src/tools/crossChecks.ts';
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
        caller?: string;
        crossChecks?: CrossChecker;
        crossCheck?: CrossCheckProfile;
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
            permissions: permissionSourceFrom(instancesOf(opts.permissions ?? { radarr: service(false, true) })),
            confirm,
            audit,
            library: { invalidate } as unknown as LibraryLoader,
            ...(opts.caller === undefined ? {} : { caller: opts.caller }),
            ...(opts.crossChecks === undefined ? {} : { crossChecks: opts.crossChecks })
        },
        {
            name: 'delete_media',
            title: 'Delete a film or series',
            description: 'Deletes a film.',
            inputSchema: z.object({ id: z.string() }),
            service: 'radarr',
            operation: 'delete_movie',
            tier: opts.tier ?? 'destructive',
            plan,
            apply,
            ...(opts.crossCheck === undefined ? {} : { crossCheck: opts.crossCheck })
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

    // A client that forwards only `content` (Claude's remote MCP path, #234;
    // Hermes from 2026.9.7) never shows the model `structuredContent`, so the
    // token has to be readable in the text or the handshake cannot complete.
    it('puts the token itself in the text, not just a pointer to confirm_token', async () => {
        const { content, structuredContent } = await harness.call('delete_media', { id: '5' });
        expect(structuredContent.confirm_token).toBeTypeOf('string');
        expect(content[0]?.text).toContain(structuredContent.confirm_token);
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

    it('puts the fresh token from a rejection in the text too', async () => {
        const { content, structuredContent } = await harness.call('delete_media', { id: '5', confirm: 'nonsense' });
        expect(content[0]?.text).toContain(structuredContent.confirm_token);
    });

    // Every failure that reissues carries a remedy telling the caller to call
    // again *without* `confirm`, which contradicts the usable token in the very
    // next sentence. A model that follows the remedy throws away a good token
    // and spends another preview. The diagnosis stays in `confirm_error`.
    // #312: the text said only "(foreign)", which is all a client that drops
    // structuredContent ever sees.
    it('says why the token was rejected in the text', async () => {
        const { content } = await harness.call('delete_media', { id: '5', confirm: 'nonsense' });
        expect(content[0]?.text).toContain('not a confirmation token issued by this server');
    });

    it('gives one next action on a rejection, not two', async () => {
        const { content, structuredContent } = await harness.call('delete_media', { id: '5', confirm: 'nonsense' });
        const text = content[0]?.text ?? '';

        expect(text).toContain(structuredContent.confirm_token);
        expect(text).not.toContain('without `confirm`');
        // #312: confirm_error said to call again without `confirm`, the text to
        // use the fresh token. Both now carry the reason alone.
        expect(structuredContent.confirm_error).toBe('That is not a confirmation token issued by this server.');
    });

    // The token is the last thing in both texts on purpose. A reader clipping
    // it out takes the trailing word or the final backticked span, and prose
    // after the token defeats both — `unwrap` strips punctuation, not a clause.
    it('ends both the preview and the rejection with the token itself', async () => {
        const ending = /`v2\.[\w.-]+`\.?$/u;

        const preview = await harness.call('delete_media', { id: '5' });
        expect(preview.content[0]?.text.trimEnd()).toMatch(ending);

        const rejected = await harness.call('delete_media', { id: '5', confirm: 'nonsense' });
        expect(rejected.content[0]?.text.trimEnd()).toMatch(ending);
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

    /**
     * Which credential asked. The context is rebuilt per request, so a request
     * that arrived on the static bearer token simply has no `caller` on it —
     * and that has to record as `bearer`, never as a blank. A blank means one
     * thing only: a row from before the column existed.
     */
    it('records the static bearer token under its own marker when no caller is set', async () => {
        await harness.call('delete_media', { id: '5', dry_run: true });
        expect((harness.audit.recent() as { caller: string | null }[])[0]?.caller).toBe(BEARER_CALLER);
    });

    it("records an OAuth request's client id", async () => {
        const oauth = buildHarness({ caller: 'oauth:desktop-client' });
        await oauth.call('delete_media', { id: '5', dry_run: true });
        expect((oauth.audit.recent() as { caller: string | null }[])[0]?.caller).toBe('oauth:desktop-client');
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

describe('write tool harness — cross-checks', () => {
    const SUBJECT = { kind: 'movie' as const, label: 'Alien (1979)', ids: { tmdb: 348 } };
    const SUBJECT_PLAN: WritePlan = { ...PLAN, subject: SUBJECT };
    const WARNING = 'Seerr still has a request for Alien (1979).';
    const advised = (warnings: string[] = [WARNING], unchecked: string[] = ['reclaimerr']) =>
        vi.fn<CrossChecker>(() => Promise.resolve({ warnings, unchecked }));
    const endsWithToken = /`v2\.[\w.-]+`\.?$/u;

    it('shows warnings on a preview, in the structured result and the text', async () => {
        const crossChecks = advised();
        const h = buildHarness({ plan: SUBJECT_PLAN, crossChecks, crossCheck: 'delete' });
        const { structuredContent, content } = await h.call('delete_media', { id: '5' });
        const text = content[0]?.text ?? '';

        expect(crossChecks).toHaveBeenCalledWith(SUBJECT, 'delete');
        expect(structuredContent.warnings).toEqual([WARNING]);
        expect(structuredContent.unchecked).toEqual(['reclaimerr']);
        expect(text).toContain(`Worth checking first:\n- ${WARNING}`);
        expect(text).toContain('Could not check: reclaimerr.');
        // Before the effects and the token, which stays last.
        expect(text.indexOf('Worth checking first')).toBeLessThan(text.indexOf(PLAN.effects[0] as string));
        expect(text.trimEnd()).toMatch(endsWithToken);
    });

    it('shows warnings in the dry-run text', async () => {
        const h = buildHarness({ plan: SUBJECT_PLAN, crossChecks: advised(), crossCheck: 'delete' });
        const { structuredContent, content } = await h.call('delete_media', { id: '5', dry_run: true });

        expect(content[0]?.text).toContain(WARNING);
        expect(content[0]?.text).toContain('Omit `dry_run`');
        expect(structuredContent.warnings).toEqual([WARNING]);
    });

    it('shows warnings on a rejected token, ahead of the fresh one', async () => {
        const h = buildHarness({ plan: SUBJECT_PLAN, crossChecks: advised(), crossCheck: 'delete' });
        const { content } = await h.call('delete_media', { id: '5', confirm: 'nonsense' });
        const text = content[0]?.text ?? '';

        expect(text).toContain(WARNING);
        expect(text.indexOf(WARNING)).toBeLessThan(text.indexOf('Do not resend'));
        expect(text.trimEnd()).toMatch(endsWithToken);
    });

    it('omits both fields when there is nothing to say', async () => {
        const h = buildHarness({ plan: SUBJECT_PLAN, crossChecks: advised([], []), crossCheck: 'delete' });
        const { structuredContent, content } = await h.call('delete_media', { id: '5' });

        expect(structuredContent).not.toHaveProperty('warnings');
        expect(structuredContent).not.toHaveProperty('unchecked');
        expect(content[0]?.text).not.toContain('Worth checking');
    });

    it('does not run cross-checks when a confirm token is applied', async () => {
        const crossChecks = advised();
        const h = buildHarness({ plan: SUBJECT_PLAN, crossChecks, crossCheck: 'delete' });
        const first = await h.call('delete_media', { id: '5' });
        const second = await h.call('delete_media', { id: '5', confirm: first.structuredContent.confirm_token });

        expect(second.structuredContent.applied).toBe(true);
        expect(second.structuredContent).not.toHaveProperty('warnings');
        expect(crossChecks).toHaveBeenCalledTimes(1);
    });

    it('applies a valid token whatever the warnings say now', async () => {
        const crossChecks = vi
            .fn<CrossChecker>()
            .mockResolvedValueOnce({ warnings: [], unchecked: [] })
            .mockResolvedValue({ warnings: ['A new warning.'], unchecked: [] });
        const h = buildHarness({ plan: SUBJECT_PLAN, crossChecks, crossCheck: 'delete' });
        const first = await h.call('delete_media', { id: '5' });
        const second = await h.call('delete_media', { id: '5', confirm: first.structuredContent.confirm_token });

        expect(second.structuredContent.applied).toBe(true);
        expect(h.apply).toHaveBeenCalledTimes(1);
    });

    it('still previews when the checker throws', async () => {
        const crossChecks = vi.fn<CrossChecker>(() => Promise.reject(new Error('boom')));
        const h = buildHarness({ plan: SUBJECT_PLAN, crossChecks, crossCheck: 'delete' });
        const { structuredContent, content } = await h.call('delete_media', { id: '5' });

        expect(structuredContent.confirm_token).toBeTypeOf('string');
        expect(structuredContent.unchecked).toEqual(['cross-service checks']);
        expect(content[0]?.text).toContain('Could not check: cross-service checks.');
    });

    it('does not run cross-checks for a no-op or a refusal', async () => {
        const crossChecks = advised();
        const noop = buildHarness({ plan: { ...SUBJECT_PLAN, noop: true }, crossChecks, crossCheck: 'delete' });
        await noop.call('delete_media', { id: '5' });

        const denied = buildHarness({
            permissions: { radarr: service(false, false) },
            plan: SUBJECT_PLAN,
            crossChecks,
            crossCheck: 'delete'
        });
        await expect(denied.call('delete_media', { id: '5' })).rejects.toThrow(ServiceError);

        expect(crossChecks).not.toHaveBeenCalled();
    });

    it('asks nothing without a profile, a subject or a checker', async () => {
        const crossChecks = advised();
        await buildHarness({ plan: SUBJECT_PLAN, crossChecks }).call('delete_media', { id: '5' });
        await buildHarness({ plan: PLAN, crossChecks, crossCheck: 'delete' }).call('delete_media', { id: '5' });
        const bare = buildHarness({ plan: SUBJECT_PLAN, crossCheck: 'delete' });
        const { structuredContent } = await bare.call('delete_media', { id: '5' });

        expect(crossChecks).not.toHaveBeenCalled();
        expect(structuredContent).not.toHaveProperty('warnings');
    });

    it('records the same single audit row with or without cross-checks', async () => {
        const h = buildHarness({ plan: SUBJECT_PLAN, crossChecks: advised(), crossCheck: 'delete' });
        await h.call('delete_media', { id: '5' });
        expect(outcomes(h)).toEqual(['unconfirmed']);
    });
});
