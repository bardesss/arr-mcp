import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { ServiceInstance } from '../config/instances.ts';
import { ServiceError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import type { ProfilarrAdapter } from '../services/profilarr.ts';
import { hasProfileDiagnostics, hasProfileFix, type ProfileDiagnosticsCapable, type ProfileFixCapable, type ServiceAdapter } from '../services/types.ts';
import { matchArr } from './profileIssues/index.ts';
import { FINDING_KINDS, floorFindings, type FindingKind } from './profileIssues/rules.ts';
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

const FIXABLE: readonly FindingKind[] = ['unreachable_floor', 'knife_edge_floor'];

type ProfilarrReads = Pick<ProfilarrAdapter, 'status' | 'listArrs'>;

const hasProfilarrReads = (a: ServiceAdapter): a is ServiceAdapter & ProfilarrReads =>
    a.type === 'profilarr' &&
    typeof (a as Partial<ProfilarrReads>).status === 'function' &&
    typeof (a as Partial<ProfilarrReads>).listArrs === 'function';

/**
 * Whether Profilarr syncs quality profiles to this instance. Its API reports
 * how many profiles it syncs per database, not which, so "some" is as exact as
 * the answer gets: a profile on a synced instance is treated as Profilarr's
 * unless Profilarr syncs none at all.
 */
async function profilarrSyncsTo(
    profilarr: ServiceAdapter & ProfilarrReads,
    adapter: ServiceAdapter,
    instances: readonly ServiceInstance[]
): Promise<boolean> {
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
    if (!status.databases.some(d => d.enabled && d.counts.qualityProfiles > 0)) return false;
    return status.arrs.some(arr => {
        if (!arr.enabled || arr.type !== adapter.type) return false;
        const entry = entries.find(e => e.id === arr.id);
        return entry !== undefined && matchArr(entry, [adapter], instances)?.id === adapter.id;
    });
}

type Scored = { minFormatScore: number; formatItems: ReadonlyArray<{ name?: unknown; score?: unknown }> };

/** What the previewed fix rests on: the floor and every scored format. A token is good only while this is unchanged. */
const stateOf = (profile: Scored): string =>
    createHash('sha256')
        .update(JSON.stringify([profile.minFormatScore, profile.formatItems.map(f => [f.name, f.score])]))
        .digest('hex')
        .slice(0, 16);

const FixProfileInput = z.object({
    ...targetInput(TARGET),
    profile: z.string().min(1).describe("The quality profile, by the name get_profile_issues printed (an id also works)."),
    finding: z.enum(FINDING_KINDS).describe("The finding's `kind` from get_profile_issues. Only a certain unreachable_floor or knife_edge_floor can be applied.")
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
            "Applies a proven quality profile fix on Radarr, Sonarr or Whisparr: for a certain unreachable_floor or knife_edge_floor finding from get_profile_issues, sets the profile's minimum custom format score to the total of its positive formats less the cheapest one, and changes nothing else. The check runs again first, so a finding that no longer holds, a likely one or Profilarr drift is refused, and so is a profile Profilarr syncs: change those in Profilarr. The old floor is in the preview; restoring it is a manual edit. Previews first; confirm to apply.",
        inputSchema: FixProfileInput,
        target: { adapters, to: TARGET },
        operation: 'update_quality_profile',
        tier: 'destructive',

        async plan({ profile, finding }, adapter): Promise<WritePlan> {
            if (!FIXABLE.includes(finding)) {
                throw new ServiceError('NotFound', adapter.id, `${finding} cannot be applied by fix_profile`, {
                    remedy:
                        finding === 'profilarr_drift'
                            ? 'Drift is reconciled by re-syncing in Profilarr.'
                            : 'Only a certain unreachable_floor or knife_edge_floor is proven; make this change by hand, in Profilarr when it syncs the profile, otherwise in the arr.'
                });
            }

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
            if (proven?.change === undefined) {
                throw new ServiceError('NotFound', adapter.id, `"${found.name}" no longer has a ${finding} finding`, {
                    remedy:
                        current.length === 0
                            ? 'Its minimum custom format score is fine as it stands; call get_profile_issues for a current list.'
                            : `It now has ${current.map(f => f.kind).join(', ')}; pass that as \`finding\`, or call get_profile_issues.`
                });
            }

            const profilarr = adapters.find(hasProfilarrReads);
            if (profilarr !== undefined && (await profilarrSyncsTo(profilarr, adapter, instances))) {
                throw new ServiceError('NotFound', adapter.id, `Profilarr syncs quality profiles to ${adapter.id}, and "${found.name}" may be one of them`, {
                    remedy: 'A change here is overwritten at the next Profilarr sync. Make it in Profilarr and sync; Profilarr does not say which profiles it syncs, so a profile it does not manage is changed in the arr.'
                });
            }

            const from = found.minFormatScore;
            const to = proven.change.minFormatScore;
            return {
                target: `${adapter.id}:${found.id}`,
                summary: `Set the minimum custom format score of "${found.name}" on ${adapter.id} from ${from} to ${to}.`,
                effects: [
                    proven.detail,
                    `${to} is the total of its positive custom formats less the cheapest, so a release missing only that one still passes. Nothing else about the profile changes.`,
                    `Releases the old minimum of ${from} rejected can now be grabbed. To undo it, set ${from} again by hand: this tool only lowers a minimum that is out of reach.`
                ],
                args: { profile_id: found.id, finding, from, to, state: stateOf(found) }
            };
        },

        async apply(plan, _args, adapter) {
            const bound = plan.args as { profile_id: number; from: number; to: number; state: string };
            // The profile as it is now, sent back whole: only the floor differs from what the arr holds.
            const now = await adapter.readQualityProfile(bound.profile_id);
            if (stateOf(now as unknown as Scored) !== bound.state) {
                throw new ServiceError('NotFound', adapter.id, `"${now.name}" changed since the preview`, {
                    remedy: 'Run fix_profile again to preview against the profile as it is now.'
                });
            }
            await adapter.updateQualityProfile({ ...now, minFormatScore: bound.to });
            return { profile: now.name, minFormatScore: { from: bound.from, to: bound.to } };
        }
    });
}
