import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { ServiceInstance } from '../config/instances.ts';
import { ServiceError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import type { ProfilarrAdapter } from '../services/profilarr.ts';
import { hasProfileDiagnostics, hasProfileFix, type ProfileDiagnosticsCapable, type ProfileFixCapable, type ServiceAdapter } from '../services/types.ts';
import { matchArr } from './profileIssues/index.ts';
import { floorFindings } from './profileIssues/rules.ts';
import { serviceTarget, targetInput } from './serviceTarget.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';

/**
 * Applies the one fix `get_profile_issues` can prove: a minimum custom format
 * score that nothing can reach, or that sits exactly on the edge. The
 * preview runs the check again, so a finding that has stopped holding is
 * refused rather than applied from a stale read.
 *
 * `destructive`: the old floor is in the preview but restoring it is a manual
 * edit, and the profile governs what the instance grabs from then on.
 */

const TARGET = serviceTarget({
    services: ['radarr', 'sonarr', 'whisparr'],
    can: (a): a is ServiceAdapter & ProfileFixCapable & ProfileDiagnosticsCapable => hasProfileFix(a) && hasProfileDiagnostics(a),
    cannot: 'has no quality profiles arr-mcp can change',
    hint: 'Take `service` and `profile` from get_profile_issues.'
});

type ProfilarrReads = Pick<ProfilarrAdapter, 'status' | 'listArrs'>;

const hasProfilarrReads = (a: ServiceAdapter): a is ServiceAdapter & ProfilarrReads =>
    a.type === 'profilarr' &&
    typeof (a as Partial<ProfilarrReads>).status === 'function' &&
    typeof (a as Partial<ProfilarrReads>).listArrs === 'function';

type ProfilarrSync = { count: number } | 'unmatched';

/**
 * How many quality profiles Profilarr syncs to this instance. It says how
 * many, never which. An enabled Profilarr entry of this type that matches no
 * configured instance at all is `unmatched`, not zero: this tool cannot show
 * the entry is not this instance, and a destructive write does not fail open.
 */
async function profilarrSync(
    profilarr: ServiceAdapter & ProfilarrReads,
    adapter: ServiceAdapter,
    all: readonly ServiceAdapter[],
    instances: readonly ServiceInstance[]
): Promise<ProfilarrSync> {
    let status;
    let entries;
    try {
        [status, entries] = await Promise.all([profilarr.status(), profilarr.listArrs()]);
    } catch (err) {
        logger.warn({ service: profilarr.id, err }, 'profilarr read failed; refusing fix_profile');
        throw new ServiceError('Unreachable', profilarr.id, `could not check whether Profilarr syncs quality profiles to ${adapter.id}`, {
            remedy: 'fix_profile will not change a profile it cannot show is not Profilarr\'s. Get Profilarr reachable and try again, or make the change in the arr itself.'
        });
    }
    const sameType = all.filter(a => a.type === adapter.type);
    let unmatched = false;
    for (const arr of status.arrs) {
        if (!arr.enabled || arr.type !== adapter.type) continue;
        const entry = entries.find(e => e.id === arr.id);
        const matched = entry === undefined ? undefined : matchArr(entry, sameType, instances);
        if (matched === undefined) unmatched = true;
        else if (matched.id === adapter.id) return { count: arr.syncedQualityProfiles };
    }
    return unmatched ? 'unmatched' : { count: 0 };
}

type Scored = { minFormatScore: number; formatItems: ReadonlyArray<{ name?: unknown; score?: unknown }> };

/**
 * What the previewed fix rests on: the floor and every named, scored format. A
 * token is good only while this is unchanged. Normalised here, so the
 * diagnostics shape read at plan and the raw record read at apply hash alike.
 */
const stateOf = (profile: Partial<Scored>): string =>
    createHash('sha256')
        .update(
            JSON.stringify([
                profile.minFormatScore ?? 0,
                (profile.formatItems ?? []).filter(f => typeof f.name === 'string').map(f => [f.name, f.score ?? 0])
            ])
        )
        .digest('hex')
        .slice(0, 16);

const FixProfileInput = z.object({
    ...targetInput(TARGET),
    profile: z.string().min(1).describe('The profile, by the name get_profile_issues printed (an id also works).'),
    finding: z.enum(['unreachable_floor', 'knife_edge_floor']).describe("The finding's `kind`.")
});

export function registerFixProfile(
    server: McpServer,
    context: WriteContext,
    adapters: readonly ServiceAdapter[],
    instances: readonly ServiceInstance[] = []
): void {
    registerWriteTool(server, context, {
        name: 'fix_profile',
        title: 'Fix a quality profile',
        description:
            "Applies a proven quality profile fix: for a certain unreachable_floor or knife_edge_floor finding from get_profile_issues, sets the profile's minimum custom format score to the total of its positive formats less the cheapest one, nothing else. Re-checks first, so a finding that no longer holds is refused, as is a profile on an instance where Profilarr syncs every profile (change it in Profilarr). The preview shows the old floor, which only a manual edit restores. Confirm to apply; returns the profile and both floors.",
        inputSchema: FixProfileInput,
        target: { adapters, to: TARGET },
        operation: 'update_quality_profile',
        tier: 'destructive',

        async plan({ profile, finding }, adapter): Promise<WritePlan> {
            const data = await adapter.readProfileDiagnostics();
            const found =
                data.profiles.find(p => p.name === profile) ??
                (/^\d+$/.test(profile) ? data.profiles.find(p => p.id === Number(profile)) : undefined);
            if (found === undefined) {
                throw new ServiceError('NotFound', adapter.id, `${adapter.id} has no quality profile "${profile}"`, {
                    remedy: `Its profiles are: ${data.profiles.map(p => p.name).join(', ') || 'none'}.`
                });
            }
            if (found.id === undefined) {
                throw new ServiceError('NotFound', adapter.id, `${adapter.id} did not report an id for "${found.name}"`, {
                    remedy: 'The profile cannot be written without one.'
                });
            }

            const current = floorFindings(found);
            const proven = current.find(f => f.kind === finding);
            if (proven !== undefined && proven.change === undefined) {
                throw new ServiceError('NotFound', adapter.id, `"${found.name}" scores fewer than two custom formats positively`, {
                    remedy: 'A floor can only be lowered by dropping a requirement, and which one is your call. Change it in the arr, or in Profilarr when it syncs the profile.'
                });
            }
            if (proven?.change === undefined) {
                throw new ServiceError('NotFound', adapter.id, `"${found.name}" no longer has a ${finding} finding`, {
                    remedy:
                        current.length === 0
                            ? 'Its minimum custom format score is fine as it stands; call get_profile_issues for a current list.'
                            : `It now has ${current.map(f => f.kind).join(', ')}; pass that as \`finding\`, or call get_profile_issues.`
                });
            }

            const profilarr = adapters.find(hasProfilarrReads);
            const from = found.minFormatScore;
            const to = proven.change.minFormatScore;
            const warning: string[] = [];
            if (profilarr !== undefined) {
                const sync = await profilarrSync(profilarr, adapter, adapters, instances);
                if (sync === 'unmatched') {
                    throw new ServiceError('NotFound', adapter.id, `Profilarr has an enabled ${adapter.type} entry that matches no configured instance, so it cannot be told whether it syncs to ${adapter.id}`, {
                        remedy: 'Make the change in Profilarr, or give the instance in config.yaml the URL or name Profilarr knows it by.'
                    });
                }
                if (sync.count >= data.profiles.length && sync.count > 0) {
                    throw new ServiceError('NotFound', adapter.id, `Profilarr syncs all ${sync.count} quality profiles on ${adapter.id}, so "${found.name}" is one of them`, {
                        remedy: 'Its next sync would put the old value back. Make the change in Profilarr and sync.'
                    });
                }
                if (sync.count > 0) {
                    warning.push(
                        `Profilarr syncs ${sync.count} of the ${data.profiles.length} profiles on ${adapter.id} and does not say which. If this is one of them, its next sync may put ${from} back: change it in Profilarr instead.`
                    );
                }
            }

            return {
                target: `${adapter.id}:${found.id}`,
                summary: `Set the minimum custom format score of "${found.name}" on ${adapter.id} from ${from} to ${to}.`,
                effects: [
                    ...warning,
                    proven.detail,
                    `${to} is the total of its positive custom formats less the cheapest, so a release missing only that one still passes. Nothing else about the profile changes.`,
                    `Releases the old minimum of ${from} rejected can now be grabbed. To undo it, set ${from} again by hand.`
                ],
                args: { profile_id: found.id, finding, from, to, state: stateOf(found) }
            };
        },

        async apply(plan, _args, adapter) {
            const bound = plan.args as { profile_id: number; from: number; to: number; state: string };
            // The profile as it is now, sent back whole: only the floor differs from what the arr holds.
            const now = await adapter.readQualityProfile(bound.profile_id);
            if (stateOf(now) !== bound.state) {
                throw new ServiceError('NotFound', adapter.id, `"${now.name}" changed since the preview`, {
                    remedy: 'Run fix_profile again to preview against the profile as it is now.'
                });
            }
            await adapter.updateQualityProfile({ ...now, minFormatScore: bound.to });
            return { profile: now.name, minFormatScore: { from: bound.from, to: bound.to } };
        }
    });
}
