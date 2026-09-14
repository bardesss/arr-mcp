import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { ServiceInstance } from '../../config/instances.ts';
import { logger } from '../../core/logger.ts';
import {
    DetailSchema,
    LimitSchema,
    OffsetSchema,
    PagedOutputSchema,
    READ_ONLY,
    applyLimit,
    listText,
    toolInput,
    type DetailLevel
} from '../../core/shape.ts';
import type { ProfilarrArrEntry, ProfilarrArrStatus, ProfilarrDrift } from '../../services/profilarr.ts';
import { hasProfileDiagnostics, type ProfileDiagnosticsCapable, type ServiceAdapter } from '../../services/types.ts';
import {
    dialectFindings,
    floorFindings,
    languagePreferenceFindings,
    subsetFindings,
    type Confidence,
    type FindingKind,
    type LanguageNames
} from './rules.ts';

type ArrServiceType = 'radarr' | 'sonarr' | 'whisparr';

export type ProfileIssue = {
    service: ArrServiceType;
    instance?: string;
    /** Absent for `profilarr_drift`, which is instance-scoped rather than
     *  about any one quality profile. */
    profile?: string;
    kind: FindingKind;
    confidence: Confidence;
    detail: string;
    remedy?: string;
};

export type GetProfileIssuesResult = {
    items: ProfileIssue[];
    total: number;
    returned: number;
    offset: number;
    truncated: boolean;
    degraded: string[];
    /** A fact about the stack's config, not this call — see the two notes below. */
    note?: string;
};

export const NO_ARR_NOTE =
    'No Radarr, Sonarr or Whisparr is configured, so there are no quality profiles to check — this is a blind ' +
    'spot, not a clean bill of health. Add one of those services in config.yaml.';

export const DRIFT_NOT_CHECKED_NOTE =
    'No `profilarr` service is configured, so drift between its saved profiles and what Radarr/Sonarr actually ' +
    'hold was not checked.';

export const DRIFT_PENDING_NOTE =
    'Profilarr has not checked for drift on at least one instance yet — that is "not checked", never "clean", ' +
    'so its absence from the findings below is not a clean bill of health.';

export const NO_MATCHING_INSTANCE_NOTE =
    'The `service`/`instance` filter matched no configured instance, so this empty result is the filter excluding ' +
    'everything, not a clean bill of health.';

/** `remedy` is dropped at `minimal` — it is guidance, not the finding itself. */
const project = (issue: ProfileIssue, detail: DetailLevel): ProfileIssue => {
    if (detail !== 'minimal') return issue;
    const { remedy: _r, ...rest } = issue;
    return rest;
};

export function profileIssueLine(issue: ProfileIssue): string {
    const where = [issue.service, issue.instance].filter((s): s is string => s !== undefined).join('/');
    const profile = issue.profile === undefined ? '' : ` \`${issue.profile}\``;
    return `${where}${profile} — ${issue.kind} (${issue.confidence}): ${issue.detail}`;
}

const isArrAdapter = (a: ServiceAdapter): a is ServiceAdapter & ProfileDiagnosticsCapable =>
    (a.type === 'radarr' || a.type === 'sonarr' || a.type === 'whisparr') && hasProfileDiagnostics(a);

type ProfilarrStatusCapable = {
    status(): Promise<{ arrs: ProfilarrArrStatus[] }>;
    listArrs(): Promise<ProfilarrArrEntry[]>;
};

const hasProfilarrStatus = (a: ServiceAdapter): a is ServiceAdapter & ProfilarrStatusCapable =>
    a.type === 'profilarr' &&
    typeof (a as Partial<ProfilarrStatusCapable>).status === 'function' &&
    typeof (a as Partial<ProfilarrStatusCapable>).listArrs === 'function';

const safeHost = (url: string | undefined): string | undefined => {
    if (url === undefined) return undefined;
    try {
        return new URL(url).host;
    } catch {
        return undefined;
    }
};

/**
 * Joins one Profilarr arr entry to the arr-mcp instance it describes: URL
 * host+port first, then a case-insensitive name match against the instance
 * name (or bare id). Never across service types, and undefined rather than a
 * guess.
 *
 * `ServiceAdapter` carries no URL of its own — `instances` is the config-level
 * source (`ServiceInstance.config.url`), keyed by the same id an adapter
 * reports. `(a as { url?: string }).url` is a second, narrower source kept for
 * a bare test double that carries its own `url` and no matching instance.
 */
export function matchArr(
    entry: ProfilarrArrEntry,
    adapters: readonly ServiceAdapter[],
    instances: readonly ServiceInstance[] = []
): ServiceAdapter | undefined {
    const sameType = adapters.filter(a => a.type === entry.type);
    const entryHost = safeHost(entry.url);
    if (entryHost !== undefined) {
        const urlOf = (a: ServiceAdapter): string | undefined =>
            instances.find(i => i.id === a.id)?.config.url ?? (a as { url?: string }).url;
        const byUrl = sameType.find(a => safeHost(urlOf(a)) === entryHost);
        if (byUrl !== undefined) return byUrl;
    }
    return sameType.find(a => (a.instance ?? a.id).toLowerCase() === entry.name.toLowerCase());
}

const driftCounts = (d: ProfilarrDrift['details']): string =>
    `${d.qualityProfiles} quality profile(s), ${d.delayProfiles} delay profile(s), ${d.mediaManagement} media management setting(s)`;

/**
 * `drift: null` means Profilarr has not checked yet — never rendered as
 * clean. Only `drifted: true` produces a finding; `drifted: false` is
 * genuinely clean and stays quiet.
 */
async function collectDriftFindings(
    profilarr: ServiceAdapter & ProfilarrStatusCapable,
    targeted: readonly ServiceAdapter[],
    opts: { service?: ArrServiceType; instance?: string },
    instances: readonly ServiceInstance[]
): Promise<{ items: ProfileIssue[]; note?: string }> {
    const [status, arrEntries] = await Promise.all([profilarr.status(), profilarr.listArrs()]);
    const entryById = new Map(arrEntries.map(e => [e.id, e]));

    const items: ProfileIssue[] = [];
    let pending = false;

    for (const arrStatus of status.arrs) {
        if (opts.service !== undefined && arrStatus.type !== opts.service) continue;
        // Profilarr is not managing this arr, so its drift status — checked
        // or not — describes a relationship that is switched off, not a
        // live fact worth surfacing.
        if (!arrStatus.enabled) continue;
        const entry = entryById.get(arrStatus.id);
        const matched = entry === undefined ? undefined : matchArr(entry, targeted, instances);

        // Set before the `instance` filter can drop this row: a pending
        // check must never disappear just because it failed to match a
        // requested instance, or "not checked yet" silently reads as clean.
        const drift = arrStatus.drift;
        if (drift === null) pending = true;

        if (opts.instance !== undefined && matched?.instance !== opts.instance) continue;
        if (drift === null) continue;
        if (!drift.drifted) continue;

        const name = entry?.name ?? arrStatus.name;
        const counts = driftCounts(drift.details);
        items.push({
            service: arrStatus.type,
            ...(matched?.instance === undefined ? {} : { instance: matched.instance }),
            kind: 'profilarr_drift',
            confidence: 'certain',
            detail:
                matched === undefined
                    ? `Profilarr's \`${name}\` ${arrStatus.type} entry has drifted from what it last synced, but does not match any configured instance — listed as unattributed: ${counts} differ.`
                    : `Profilarr's saved profiles have drifted from what this ${arrStatus.type} instance currently holds: ${counts} differ.`,
            remedy: 'In Profilarr, review the drift and re-sync this arr to reconcile it.'
        });
    }

    return { items, ...(pending ? { note: DRIFT_PENDING_NOTE } : {}) };
}

export async function buildGetProfileIssues(
    adapters: readonly ServiceAdapter[],
    opts: { detail: DetailLevel; limit: number; offset?: number; service?: ArrServiceType; instance?: string; profile?: string },
    /** Optional and last, so every existing call site keeps compiling. */
    instances: readonly ServiceInstance[] = []
): Promise<GetProfileIssuesResult> {
    const arrAdapters = adapters.filter(isArrAdapter);
    const profilarr = adapters.find(hasProfilarrStatus);

    if (arrAdapters.length === 0) {
        return { items: [], total: 0, returned: 0, offset: 0, truncated: false, degraded: [], note: NO_ARR_NOTE };
    }

    const targeted = arrAdapters.filter(
        a =>
            (opts.service === undefined || a.type === opts.service) &&
            (opts.instance === undefined || a.instance === opts.instance)
    );

    const items: ProfileIssue[] = [];
    const degraded: string[] = [];
    const notes: string[] = [];

    if (targeted.length === 0) notes.push(NO_MATCHING_INSTANCE_NOTE);

    await Promise.all(
        targeted.map(async adapter => {
            let data;
            try {
                data = await adapter.readProfileDiagnostics();
            } catch (err) {
                logger.warn({ service: adapter.id, err }, 'profile diagnostics read failed; degrading');
                degraded.push(adapter.id);
                return;
            }

            // Built per instance, never shared: Radarr and Sonarr do not agree
            // on language ids.
            const languages: LanguageNames = new Map(data.languages.map(l => [l.id, l.name]));
            const profiles =
                opts.profile === undefined ? data.profiles : data.profiles.filter(p => p.name === opts.profile);

            for (const profile of profiles) {
                const findings = [
                    ...floorFindings(profile),
                    ...subsetFindings(profile, data.formats),
                    ...languagePreferenceFindings(profile, data.formats),
                    ...dialectFindings(profile, data.formats, languages)
                ];
                for (const f of findings) {
                    items.push({
                        ...f,
                        service: adapter.type as ArrServiceType,
                        ...(adapter.instance === undefined ? {} : { instance: adapter.instance }),
                        profile: profile.name
                    });
                }
            }
        })
    );

    if (profilarr === undefined) {
        notes.push(DRIFT_NOT_CHECKED_NOTE);
    } else {
        try {
            const drift = await collectDriftFindings(
                profilarr,
                targeted,
                {
                    ...(opts.service === undefined ? {} : { service: opts.service }),
                    ...(opts.instance === undefined ? {} : { instance: opts.instance })
                },
                instances
            );
            items.push(...drift.items);
            if (drift.note !== undefined) notes.push(drift.note);
        } catch (err) {
            logger.warn({ service: profilarr.id, err }, 'profilarr status read failed; degrading');
            degraded.push(profilarr.id);
        }
    }

    const shaped = applyLimit(items, opts.limit, opts.offset);
    return {
        ...shaped,
        items: shaped.items.map(i => project(i, opts.detail)),
        degraded: degraded.sort(),
        ...(notes.length > 0 ? { note: notes.join(' ') } : {})
    };
}

export const summarizeProfileIssues = (result: GetProfileIssuesResult, arrInstanceCount: number): string => {
    if (arrInstanceCount === 0) return result.note ?? '';
    const withNote = (text: string): string => (result.note === undefined ? text : `${text} ${result.note}`);
    // Profilarr can degrade alongside the arr adapters; only an all-arr outage
    // means no profile diagnostics at all, so it is counted on its own here.
    const arrDegraded = result.degraded.filter(id => id !== 'profilarr');
    if (arrDegraded.length > 0 && arrDegraded.length === arrInstanceCount)
        return withNote(`${arrDegraded.join(', ')} could not be reached; no profile diagnostics available.`);
    const counts = `${result.returned} of ${result.total} issue(s) found${result.degraded.length > 0 ? `. ${result.degraded.join(', ')} could not be reached` : ''}.`;
    return withNote(counts);
};

export function registerGetProfileIssues(
    server: McpServer,
    adapters: readonly ServiceAdapter[],
    instances?: readonly ServiceInstance[]
): void {
    server.registerTool(
        'get_profile_issues',
        {
            title: 'Profile issues',
            annotations: READ_ONLY,
            description:
                'Faults in Radarr, Sonarr and Whisparr quality profiles that Profilarr, not arr-mcp, can fix: a ' +
                'minimum custom format score nothing can reach, a score set exactly on the edge, a narrower ' +
                'language format scored while a wider one sits at zero, a language scored without a minimum to ' +
                'enforce it, a dialect sibling left uncovered, and Profilarr-reported drift between its saved ' +
                'profiles and what an instance actually holds. Drift findings are instance-scoped, not tied to any ' +
                'one profile, and are unaffected by the `profile` filter. Read-only — every `remedy` names a ' +
                'change to make in Profilarr, never one arr-mcp performs. `note` explains when nothing was ' +
                'configured to check.',
            outputSchema: PagedOutputSchema.extend({
                note: z
                    .string()
                    .optional()
                    .describe(
                        "Present when a fact about the stack's config, not this call, needs stating — no arr " +
                            'service configured at all, or no `profilarr` to check drift against.'
                    )
            }),
            inputSchema: toolInput({
                detail: DetailSchema,
                limit: LimitSchema,
                offset: OffsetSchema,
                service: z.enum(['radarr', 'sonarr', 'whisparr']).optional().describe('Only report on this service.'),
                instance: z.string().optional().describe('Only report on this named instance.'),
                profile: z.string().optional().describe('Only report on this quality profile, by name.')
            })
        },
        async ({ detail, limit, offset, service, instance, profile }) => {
            const result = await buildGetProfileIssues(
                adapters,
                {
                    detail,
                    limit,
                    offset,
                    ...(service === undefined ? {} : { service }),
                    ...(instance === undefined ? {} : { instance }),
                    ...(profile === undefined ? {} : { profile })
                },
                instances
            );
            const arrInstanceCount = adapters.filter(isArrAdapter).length;
            const summary = summarizeProfileIssues(result, arrInstanceCount);

            return {
                content: [{ type: 'text', text: listText(summary, result.items, profileIssueLine) }],
                structuredContent: result
            };
        }
    );
}
