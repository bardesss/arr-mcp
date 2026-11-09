import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { BEARER_CALLER, type WriteAudit } from '../core/audit.ts';
import { CONFIRM_REASON, type ConfirmTokens, type WriteIntent } from '../core/confirm.ts';
import { ServiceError } from '../core/errors.ts';
import { nextStepLine, type NextStep } from '../core/nextStep.ts';
import { checkPermission, type PermissionSource, type WriteTier } from '../core/permissions.ts';
import { toolInput } from '../core/shape.ts';
import { logger } from '../core/logger.ts';
import type { CrossCheckProfile, CrossCheckSubject, CrossChecker } from './crossChecks.ts';
import type { LibraryLoader } from './library.ts';
import { resolveTarget, type ServiceTarget } from './serviceTarget.ts';
import type { ServiceId } from '../config/schema.ts';
import type { ServiceAdapter } from '../services/types.ts';

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
export type WritePlan<Bound extends Record<string, unknown> = Record<string, unknown>> = {
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
    args?: Bound;
    /**
     * Set when the plan resolved successfully but there is nothing to do — the
     * film is already monitored, the request is already approved. The harness
     * short-circuits: no token, no confirmation, no write, and the audit
     * records it as a dry run. A confirmation prompt for a no-op trains a
     * model to confirm reflexively.
     */
    noop?: boolean;
    /**
     * The title this write touches, for the cross-checks. Only read when the
     * tool sets `crossCheck`, so a plan can always fill it in. A function is
     * for a subject that costs an upstream read to name: the harness calls it
     * only when it asks for advice, so a confirm never pays for it.
     */
    subject?: CrossCheckSubject | (() => Promise<CrossCheckSubject>);
};

/** For a tool whose `apply` returns the sentence to show: use it as the applied text. */
export const outcomeText = (outcome: unknown): string | undefined => (typeof outcome === 'string' ? outcome : undefined);

/**
 * Which service's permissions govern a call: either worked out from the
 * arguments, or the adapter a `target` resolves them to, which `plan` and
 * `apply` then receive rather than looking it up again.
 */
type Routing<Schema extends z.ZodObject, Adapter> =
    | {
          /**
           * A fixed id for a single-service tool, or a function of the
           * arguments for one that spans several.
           *
           * It must be derived from the arguments and nothing else. Resolving it from
           * the *plan* would let a tool that had already done a read decide its own
           * permission scope, and a fixed id on a multi-service tool is worse still:
           * it would check Sonarr writes against Radarr's `permissions` block, so
           * enabling one service would quietly enable the other.
           */
          service: string | ((args: z.infer<Schema>) => string);
          target?: never;
      }
    | {
          /**
           * The instance the `service` and `instance` arguments name, refused unless
           * it can do this write. Its id is the permission key, not the bare type:
           * checking `radarr` against a config that only grants `radarr/hd` would
           * deny a permitted write, or worse, the reverse.
           */
          target: { adapters: readonly ServiceAdapter[]; to: ServiceTarget<Adapter & ServiceAdapter> };
          service?: never;
      };

export type WriteToolSpec<
    Schema extends z.ZodObject,
    Adapter = undefined,
    Bound extends Record<string, unknown> = Record<string, unknown>
> = Routing<Schema, Adapter> & {
    name: string;
    /** What a client shows a person in place of `delete_episode_files`. */
    title: string;
    description: string;
    /** Tool-specific arguments. `dry_run` and `confirm` are added here, so no
     *  write tool can accidentally omit or redefine them. */
    inputSchema: Schema;
    /** The adapter-level verb, e.g. `delete_movie`; one tool may reach several. */
    operation: string;
    /**
     * Fixed for most tools. A function for one whose actions differ in kind
     * (`manage_indexer` disables or deletes), derived from the arguments for
     * the same reason `service` is. Such a tool is advertised as destructive,
     * since it can be.
     */
    tier: WriteTier | ((args: z.infer<Schema>) => WriteTier);
    /** `adapter` is the one `target` resolved; a tool routed by `service` has none. */
    plan(args: z.infer<Schema>, adapter: Adapter & ServiceAdapter): Promise<WritePlan<Bound>>;
    apply(plan: WritePlan<Bound>, args: z.infer<Schema>, adapter: Adapter & ServiceAdapter): Promise<unknown>;
    /**
     * Optional override for the sentence shown after a successful apply.
     * Most tools need none — `plan.summary` describes the effect and the
     * effect happened, so `Applied. ${plan.summary}` is always true. A tool
     * whose apply can turn out to have done nothing (a sync that found
     * nothing to pull) supplies this to say so; returning `undefined` falls
     * back to the default sentence.
     */
    applied?(outcome: unknown, plan: WritePlan<Bound>): string | undefined;
    /**
     * Calls worth offering now that the write has landed, as data for a client
     * to put to the person. Never run here. Called after the write only: a
     * throw is logged and the write is still reported, since it already happened.
     */
    followUps?(outcome: unknown, args: z.infer<Schema>, plan: WritePlan<Bound>): NextStep[];
    /**
     * Which questions to ask the rest of the stack when this write is
     * previewed. Run by the harness, not by `plan`: `plan` runs again on the
     * confirm call, and reads there would make an apply slow or fail on a
     * service that is down. Previews only, so the invariant above holds: the
     * preview path cannot mutate, and a valid token applies whatever the
     * warnings say now.
     */
    crossCheck?: CrossCheckProfile;
};

export type WriteContext = {
    permissions: PermissionSource;
    confirm: ConfirmTokens;
    audit: WriteAudit;
    /** Invalidated after a successful write. */
    library: LibraryLoader;
    /**
     * Which credential this request arrived on, for the audit row.
     *
     * Every `/mcp` request sets it, in `cappedTools` (`app.ts`). The
     * `BEARER_CALLER` fallback only serves contexts built outside `/mcp`.
     */
    caller?: string;
    /** Absent in a context built without one; a tool that sets `crossCheck` then previews as it always did. */
    crossChecks?: CrossChecker;
};

const DryRunSchema = z
    .boolean()
    .default(false)
    .describe(
        'Preview without a confirm token, for "what would happen if" questions; not the first step of a real change.'
    );

const ConfirmSchema = z
    .string()
    .optional()
    .describe(
        'The token from this tool\'s preview, passed back verbatim to apply it. Single-use and bound to the previewed arguments.'
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
    audit_id: z.number().optional().describe('The audit row this call wrote. Every branch writes one, including previews and refusals.'),
    warnings: z
        .array(z.string())
        .optional()
        .describe('Present on a preview when another service has something to say about this change. Tell the user before confirming.'),
    unchecked: z
        .array(z.string())
        .optional()
        .describe('Present when a service could not be asked, so its absence from `warnings` means nothing.'),
    next_steps: z
        .array(z.looseObject({ tool: z.string(), arguments: z.looseObject({}), why: z.string() }))
        .optional()
        .describe('Present on an applied write when another call is worth offering. Offer it to the person; do not run it.')
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
    /** Other services' findings, on a preview. Omitted when there are none. */
    warnings?: string[];
    /** Services the cross-checks could not read. Omitted when there are none. */
    unchecked?: string[];
    /** Calls worth offering after an applied write. Omitted when there are none. */
    next_steps?: NextStep[];
};

const TARGET_KEYS = [
    'id',
    'item_id',
    'download_id',
    'external_id',
    'media_id',
    'library',
    'title',
    'definition',
    'query',
    'database'
] as const;

/** The identifying argument as the caller gave it, for a refusal that never resolved the plan. */
export function rawTarget(args: Record<string, unknown>): string {
    for (const key of TARGET_KEYS) {
        const value = args[key];
        if (typeof value === 'string' || typeof value === 'number') return String(value);
    }
    return '';
}

/**
 * The one place a write tool is turned into an MCP tool. Every branch below
 * either records an audit row or is a pure preview that records one as
 * `dry_run` — there is no path from arguments to `apply` that skips the tier
 * check, the confirmation, or the trail.
 */
export function registerWriteTool<
    Schema extends z.ZodObject,
    Adapter = undefined,
    Bound extends Record<string, unknown> = Record<string, unknown>
>(server: McpServer, context: WriteContext, spec: WriteToolSpec<Schema, Adapter, Bound>): void {
    const { permissions, confirm, audit, library } = context;
    // Resolved once per registration, not per call: the context is rebuilt per
    // request, so a tool registered from it already belongs to one credential.
    const caller = context.caller ?? BEARER_CALLER;

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
            annotations: { readOnlyHint: false, destructiveHint: spec.tier !== 'safe' },
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
            const tier = typeof spec.tier === 'function' ? spec.tier(args) : spec.tier;
            let service: string;
            let adapter: Adapter & ServiceAdapter;
            if (spec.target !== undefined) {
                const { service: type, instance } = args as { service: ServiceId; instance?: string };
                try {
                    adapter = resolveTarget(spec.target.adapters, spec.target.to, type, instance);
                } catch (err) {
                    // Refused before anything else ran, and recorded like any other refusal.
                    const id = audit.begin({ tool: spec.name, service: type, operation: spec.operation, tier, target: rawTarget(args), args: {}, caller });
                    audit.settle(id, 'denied', err instanceof Error ? err.message : String(err));
                    throw err;
                }
                service = adapter.id;
            } else {
                service = typeof spec.service === 'function' ? spec.service(args) : spec.service;
                adapter = undefined as unknown as Adapter & ServiceAdapter;
            }

            // A refusal costs no upstream read, so it names the argument as
            // given rather than the resolved title. A dry run still resolves
            // the plan, because that is how "what would I need to enable?"
            // gets answered.
            const verdict = checkPermission(permissions, service, tier);
            const permission: WriteToolResult['permission'] = verdict.allowed
                ? { allowed: true }
                : { allowed: false, reason: verdict.reason, remedy: verdict.remedy };

            if (!verdict.allowed && !dryRun) {
                const given = rawTarget(args);
                const id = audit.begin({
                    tool: spec.name,
                    service,
                    operation: spec.operation,
                    tier,
                    target: given,
                    args: {},
                    caller
                });
                audit.settle(id, 'denied', verdict.reason);
                throw new ServiceError(
                    'PermissionDenied',
                    service,
                    `${verdict.reason} (${tier} write ${spec.operation} on ${given === '' ? service : `${service}:${given}`})`,
                    { remedy: verdict.remedy }
                );
            }

            const plan = await spec.plan(args, adapter);

            const record = {
                tool: spec.name,
                service,
                operation: spec.operation,
                tier,
                target: plan.target,
                args: plan.args ?? {},
                caller
            };

            const preview = (extra: Partial<WriteToolResult>): WriteToolResult => ({
                applied: false,
                dry_run: dryRun,
                tool: spec.name,
                service,
                operation: spec.operation,
                tier,
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

            // Asked on the preview paths only, never for a no-op, a refusal or
            // an applied write. Reads are not permission-gated, and they write no
            // audit row.
            const advise = async (): Promise<{ fields: Partial<WriteToolResult>; block: string }> => {
                if (spec.crossCheck === undefined || plan.subject === undefined || context.crossChecks === undefined) {
                    return { fields: {}, block: '' };
                }
                let advice: { warnings: string[]; unchecked: string[] };
                try {
                    const subject = typeof plan.subject === 'function' ? await plan.subject() : plan.subject;
                    advice = await context.crossChecks(subject, spec.crossCheck);
                } catch (err) {
                    logger.warn({ tool: spec.name, err }, 'cross-checks threw; previewing without them');
                    advice = { warnings: [], unchecked: ['cross-service checks'] };
                }
                const parts = [
                    advice.warnings.length === 0 ? '' : `Worth checking first:\n${advice.warnings.map(w => `- ${w}`).join('\n')}`,
                    advice.unchecked.length === 0 ? '' : `Could not check: ${advice.unchecked.join(', ')}.`
                ].filter(p => p !== '');
                return {
                    fields: {
                        ...(advice.warnings.length === 0 ? {} : { warnings: advice.warnings }),
                        ...(advice.unchecked.length === 0 ? {} : { unchecked: advice.unchecked })
                    },
                    block: parts.join('\n\n')
                };
            };

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
                const advice = await advise();
                return respond(
                    preview({ audit_id: id, ...advice.fields }),
                    `Dry run — nothing was changed. ${plan.summary}` +
                        (advice.block === '' ? ' ' : `\n\n${advice.block}\n\n`) +
                        (verdict.allowed
                            ? 'Omit `dry_run` to preview it for real and receive a confirmation token.'
                            : `Note that this write would currently be refused: ${verdict.reason}. ${verdict.remedy}`)
                );
            }

            const intent: WriteIntent = {
                tool: spec.name,
                service,
                tier,
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
                    const fresh = confirm.issue(intent);
                    const advice = await advise();
                    return respond(
                        preview({
                            audit_id: id,
                            ...advice.fields,
                            confirm_error: CONFIRM_REASON[check.failure],
                            confirm_token: fresh
                        }),
                        // `check.remedy` says to call again *without* `confirm`, which is
                        // right when no token comes back and wrong here, because one does,
                        // so both fields carry the reason alone (#312). The text gives the
                        // single next action, worded as the plain preview words it. The
                        // token goes last in both: a reader clipping the trailing word or
                        // the final backticked span gets it, and prose after it would not.
                        `Not applied — the confirmation token was rejected. ${CONFIRM_REASON[check.failure]}` +
                            (advice.block === '' ? ' ' : `\n\n${advice.block}\n\n`) +
                            `Do not resend the rejected one. To apply this, call ${spec.name} again with ` +
                            `the same arguments plus \`confirm\` set to \`${fresh}\`.`
                    );
                }
            } else {
                const id = audit.begin(record);
                audit.settle(id, 'unconfirmed');
                // The token goes in the text as well as in `confirm_token`: not
                // every client forwards structuredContent to the model (#234), and
                // a preview whose text names a field the model cannot see is a
                // handshake it can never complete.
                const token = confirm.issue(intent);
                const advice = await advise();
                return respond(
                    preview({ audit_id: id, confirm_token: token, ...advice.fields }),
                    `Not applied yet. ${plan.summary}\n\n` +
                        (advice.block === '' ? '' : `${advice.block}\n\n`) +
                        `${plan.effects.map(e => `- ${e}`).join('\n')}\n\n` +
                        `To apply this, call ${spec.name} again with the same arguments plus \`confirm\` set to \`${token}\`.`
                );
            }

            // --- 5. Apply ---------------------------------------------------------
            const id = audit.begin(record);
            let outcome: unknown;
            try {
                outcome = await spec.apply(plan, args, adapter);
            } catch (err) {
                audit.settle(id, 'failed', err instanceof Error ? err.message : String(err));
                throw err;
            }

            // Only after a write that actually landed: a failed write changed
            // nothing, and dropping the cache for it would cost every cached
            // library snapshot for no reason.
            library.invalidate();
            audit.settle(id, 'applied');

            // After the write, and guarded: the write has happened, so a follow-up
            // that fails to build must not turn a landed change into an error.
            let nextSteps: NextStep[] = [];
            try {
                nextSteps = spec.followUps?.(outcome, args, plan) ?? [];
            } catch (err) {
                logger.warn({ tool: spec.name, err }, 'followUps threw; reporting the write without next steps');
            }

            return respond(
                {
                    ...preview({ audit_id: id }),
                    applied: true,
                    ...(outcome === undefined ? {} : { result: outcome }),
                    ...(nextSteps.length === 0 ? {} : { next_steps: nextSteps })
                },
                // In the text as well as the field (#234).
                (spec.applied?.(outcome, plan) ?? `Applied. ${plan.summary}`) + nextSteps.map(step => `\n${nextStepLine(step)}`).join('')
            );
        }
    );
}
