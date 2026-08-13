import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { WriteAudit } from '../core/audit.ts';
import type { ConfirmTokens, WriteIntent } from '../core/confirm.ts';
import { ServiceError } from '../core/errors.ts';
import { checkPermission, type PermissionSource, type WriteTier } from '../core/permissions.ts';
import { toolInput } from '../core/shape.ts';
import type { LibraryLoader } from './library.ts';

/**
 * The four properties every write must have — permission tier, `dry_run`, an
 * audit record, per-call confirmation — are this function, not four things each
 * tool remembers. A tool supplies only what is specific to it: `plan`, which
 * describes an effect without touching anything, and `apply`, reached only once
 * all four gates pass.
 *
 * That split is the design. A tool physically cannot mutate during preview,
 * because preview only calls `plan` — the mutating code sits in a callback the
 * harness declines to invoke. So reviewing a write tool means reading its
 * `plan`/`apply` pair, not auditing whether it checked permissions.
 */

/** What `plan` resolved the request into: a concrete target and a description
 *  of the effect, in the model's words rather than the service's. */
export type WritePlan = {
    /** The resolved id the write will act on. The confirmation token binds to
     *  this, so a token cannot survive re-resolving a title to a different film. */
    target: string;
    /** One sentence, safe to show a human: "Delete Alien (1979) from Radarr, leaving files on disk." */
    summary: string;
    /** Itemised consequences, most severe first. Empty is legitimate for a
     *  no-op — see the `noop` field. */
    effects: string[];
    /** Effect-bearing arguments, folded into the token binding. Anything that
     *  changes what `apply` does belongs here or the token would not commit to it. */
    args?: Record<string, unknown>;
    /**
     * Set when the plan resolved successfully but there is nothing to do — the
     * film is already monitored, the request is already approved. The harness
     * short-circuits: no token, no confirmation, no write, and the audit
     * records it as a dry run. A confirmation prompt for a no-op trains a
     * model to confirm reflexively.
     */
    noop?: boolean;
};

export type WriteToolSpec<Schema extends z.ZodObject> = {
    name: string;
    /** What a client shows a person in place of `delete_episode_files`. */
    title: string;
    description: string;
    /** Tool-specific arguments. `dry_run` and `confirm` are added here, so no
     *  write tool can accidentally omit or redefine them. */
    inputSchema: Schema;
    /**
     * Which service's permissions govern this call — a fixed id for a
     * single-service tool, or a function of the arguments for one that spans
     * several (`trigger_search` reaches both Radarr and Sonarr).
     *
     * It must be derived from the arguments and nothing else. Resolving it from
     * the *plan* would let a tool that had already done a read decide its own
     * permission scope, and a fixed id on a multi-service tool is worse still:
     * it would check Sonarr writes against Radarr's `permissions` block, so
     * enabling one service would quietly enable the other.
     */
    service: string | ((args: z.infer<Schema>) => string);
    /** The adapter-level verb, e.g. `delete_movie`; one tool may reach several. */
    operation: string;
    tier: WriteTier;
    plan(args: z.infer<Schema>): Promise<WritePlan>;
    apply(plan: WritePlan, args: z.infer<Schema>): Promise<unknown>;
};

export type WriteContext = {
    permissions: PermissionSource;
    confirm: ConfirmTokens;
    audit: WriteAudit;
    /** Invalidated after a successful write. */
    library: LibraryLoader;
};

const DryRunSchema = z
    .boolean()
    .default(false)
    .describe(
        'Preview only: resolve the target and describe exactly what would happen, then stop. Never mutates anything and never returns a confirmation token. Use this to answer "what would happen if…" — not as the first step of actually doing it.'
    );

const ConfirmSchema = z
    .string()
    .optional()
    .describe(
        'The confirmation token from this same tool\'s preview of this same operation. Omit it to get a preview and a token; pass the token back verbatim to apply the change. Tokens are single-use, expire, and are bound to the exact operation and arguments previewed.'
    );

/**
 * What every write answers with, declared for the same reason the read
 * envelope is (#103): a client that gates `structuredContent` on a declared
 * schema shows the caller nothing without one.
 *
 * It matters more here than on a read. `applied` is the difference between "I
 * deleted it" and "I would delete it, confirm first", and a model that cannot
 * see the structured half has to infer which happened from a sentence. Getting
 * that wrong in the reassuring direction — reporting a preview as done — is the
 * failure the whole confirm handshake exists to prevent.
 *
 * Loose, like the read envelope: a validation failure here would fail the call
 * *after* the write had already landed, reporting a completed deletion as an
 * error. The optional fields are genuinely conditional — a token is issued only
 * when there is something to confirm.
 */
const WriteOutputSchema = z.looseObject({
    applied: z.boolean().describe('Whether the change actually happened. False on every preview, refusal and no-op.'),
    dry_run: z.boolean().describe('Whether this was an explicit preview.'),
    tool: z.string(),
    service: z.string(),
    operation: z.string(),
    tier: z.enum(['safe', 'destructive']),
    target: z.string().describe('The resolved id the write acts on — what the confirmation token is bound to.'),
    summary: z.string().describe('One sentence, safe to show a human.'),
    effects: z.array(z.string()).describe('Itemised consequences, most severe first. Empty is legitimate for a no-op.'),
    noop: z.boolean().describe('True when the request resolved but there was nothing to do — already monitored, already approved.'),
    permission: z.looseObject({
        allowed: z.boolean(),
        reason: z.string().optional(),
        remedy: z.string().optional()
    }),
    confirm_token: z.string().optional().describe('Present when a preview is awaiting confirmation. Single-use, expiring, bound to this exact operation and arguments.'),
    confirm_error: z.string().optional().describe('Why a presented token was rejected. Present only when one was presented.'),
    result: z.unknown().optional().describe('Whatever the service returned, on a write that landed.'),
    audit_id: z.number().optional().describe('The audit row this call wrote. Every branch writes one, including previews and refusals.')
});

export type WriteToolResult = {
    applied: boolean;
    dry_run: boolean;
    tool: string;
    service: string;
    operation: string;
    tier: WriteTier;
    target: string;
    summary: string;
    effects: string[];
    noop: boolean;
    permission: { allowed: boolean; reason?: string; remedy?: string };
    confirm_token?: string;
    /** Why a presented token was rejected. Present only when one was presented. */
    confirm_error?: string;
    /** Whatever `apply` returned, on a real write. */
    result?: unknown;
    audit_id?: number;
};

/**
 * The one place a write tool is turned into an MCP tool. Every branch below
 * either records an audit row or is a pure preview that records one as
 * `dry_run` — there is no path from arguments to `apply` that skips the tier
 * check, the confirmation, or the trail.
 */
export function registerWriteTool<Schema extends z.ZodObject>(
    server: McpServer,
    context: WriteContext,
    spec: WriteToolSpec<Schema>
): void {
    const { permissions, confirm, audit, library } = context;

    server.registerTool(
        spec.name,
        {
            title: spec.title,
            /**
             * The permission tier, said out loud to the client.
             *
             * Read from `spec.tier` rather than declared a second time, because
             * a tool gated as destructive and advertised as safe is worse than
             * one that says nothing at all — a client auto-approving on the
             * annotation would be reading a claim the gate itself contradicts.
             *
             * `idempotentHint` is deliberately omitted, which the spec reads as
             * false. It would be a lie in either direction here: the confirm
             * token is single-use, so an identical repeated call does not
             * repeat the write — it fails the token check. Nothing a client
             * would do with the hint is right for that.
             */
            annotations: { readOnlyHint: false, destructiveHint: spec.tier === 'destructive' },
            description: spec.description,
            // Rebuilt through `toolInput` rather than extended, and the
            // difference is the error text: strictness carried over from the
            // spec's own schema would list only the tool's half, so a caller
            // that mistyped one argument would be told `dry_run` and `confirm`
            // — the two parameters the write protocol itself runs on — are not
            // parameters of this tool.
            inputSchema: toolInput({ ...spec.inputSchema.shape, dry_run: DryRunSchema, confirm: ConfirmSchema }),
            outputSchema: WriteOutputSchema
        },
        async (raw: Record<string, unknown>) => {
            const { dry_run: dryRun, confirm: presented, ...rest } = raw as {
                dry_run: boolean;
                confirm?: string;
            };
            const args = rest as z.infer<Schema>;

            // Resolved from the arguments alone, before anything else runs, so
            // the service whose permissions are checked is the service the
            // audit names and the token binds to. Deriving it later — from the
            // plan, say — would let the three disagree.
            const service = typeof spec.service === 'function' ? spec.service(args) : spec.service;

            // Resolution happens first, and for every path including a denied
            // one. A refusal that cannot even name what it refused ("permission
            // denied" with no film attached) is not actionable, and resolving
            // is a read — already permitted, and already what the model could
            // do for itself with get_media_details.
            const plan = await spec.plan(args);

            const verdict = checkPermission(permissions, service, spec.tier);
            const permission: WriteToolResult['permission'] = verdict.allowed
                ? { allowed: true }
                : { allowed: false, reason: verdict.reason, remedy: verdict.remedy };

            const record = {
                tool: spec.name,
                service,
                operation: spec.operation,
                tier: spec.tier,
                target: plan.target,
                args: plan.args ?? {}
            };

            const preview = (extra: Partial<WriteToolResult>): WriteToolResult => ({
                applied: false,
                dry_run: dryRun,
                tool: spec.name,
                service,
                operation: spec.operation,
                tier: spec.tier,
                target: plan.target,
                summary: plan.summary,
                effects: plan.effects,
                noop: plan.noop === true,
                permission,
                ...extra
            });

            const respond = (result: WriteToolResult, text: string) => ({
                content: [{ type: 'text' as const, text }],
                structuredContent: result
            });

            // --- 1. Nothing to do -------------------------------------------------
            if (plan.noop === true) {
                const id = audit.begin(record);
                audit.settle(id, 'dry_run', 'no-op: already in the requested state');
                return respond(
                    preview({ audit_id: id }),
                    `Nothing to do — ${plan.summary} No change was made and no confirmation is needed.`
                );
            }

            // --- 2. dry_run: terminal preview, never gated ------------------------
            //
            // A dry run is deliberately *not* refused when the tier is off. It
            // performs no mutation, and everything it reveals is already
            // reachable through the read tools — so refusing it would withhold
            // nothing while making "what would I need to enable to do this?"
            // unanswerable. The verdict rides along in `permission` instead, so
            // the model learns the write would be refused and can say so.
            if (dryRun) {
                const id = audit.begin(record);
                audit.settle(id, 'dry_run', verdict.allowed ? undefined : verdict.reason);
                return respond(
                    preview({ audit_id: id }),
                    `Dry run — nothing was changed. ${plan.summary}` +
                        (verdict.allowed
                            ? ' Omit `dry_run` to preview it for real and receive a confirmation token.'
                            : ` Note that this write would currently be refused: ${verdict.reason}. ${verdict.remedy}`)
                );
            }

            // --- 3. Permission tier ----------------------------------------------
            if (!verdict.allowed) {
                const id = audit.begin(record);
                audit.settle(id, 'denied', verdict.reason);
                throw new ServiceError('PermissionDenied', service, verdict.reason, { remedy: verdict.remedy });
            }

            const intent: WriteIntent = {
                tool: spec.name,
                service,
                tier: spec.tier,
                operation: spec.operation,
                target: plan.target,
                ...(plan.args === undefined ? {} : { args: plan.args })
            };

            // --- 4. Confirmation --------------------------------------------------
            if (presented !== undefined) {
                const check = confirm.verifyAndConsume(presented, intent);
                if (!check.ok) {
                    // An already-spent token is the one rejection that does not
                    // get a fresh one. The write it authorised may well have
                    // happened, and handing back a new token invites a model
                    // that lost track to apply it twice — the exact duplicate
                    // single-use exists to prevent. Every other rejection is a
                    // caller mistake with no such risk, so it degrades to a
                    // normal preview carrying the reason.
                    if (check.failure === 'used') {
                        const id = audit.begin(record);
                        audit.settle(id, 'denied', 'confirmation token already used');
                        throw new ServiceError('PermissionDenied', service, 'confirmation token already used', {
                            remedy: check.remedy
                        });
                    }

                    const id = audit.begin(record);
                    audit.settle(id, 'unconfirmed', `confirmation ${check.failure}`);
                    return respond(
                        preview({
                            audit_id: id,
                            confirm_error: check.remedy,
                            confirm_token: confirm.issue(intent)
                        }),
                        `Not applied — the confirmation token was rejected (${check.failure}). ${check.remedy} A fresh token for this exact operation is in \`confirm_token\`.`
                    );
                }
            } else {
                const id = audit.begin(record);
                audit.settle(id, 'unconfirmed');
                return respond(
                    preview({ audit_id: id, confirm_token: confirm.issue(intent) }),
                    `Not applied yet. ${plan.summary}\n\n` +
                        `${plan.effects.map(e => `- ${e}`).join('\n')}\n\n` +
                        `To apply this, call ${spec.name} again with the same arguments plus \`confirm\` set to the token in \`confirm_token\`.`
                );
            }

            // --- 5. Apply ---------------------------------------------------------
            const id = audit.begin(record);
            let outcome: unknown;
            try {
                outcome = await spec.apply(plan, args);
            } catch (err) {
                audit.settle(id, 'failed', err instanceof Error ? err.message : String(err));
                throw err;
            }

            // Only after a write that actually landed: a failed write changed
            // nothing, and dropping the cache for it would cost every cached
            // library snapshot for no reason.
            library.invalidate();
            audit.settle(id, 'applied');

            return respond(
                { ...preview({ audit_id: id }), applied: true, ...(outcome === undefined ? {} : { result: outcome }) },
                `Applied. ${plan.summary}`
            );
        }
    );
}
