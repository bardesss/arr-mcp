import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
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
    profile: string;
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

/** `remedy` is dropped at `minimal` — it is guidance, not the finding itself. */
const project = (issue: ProfileIssue, detail: DetailLevel): ProfileIssue => {
    if (detail !== 'minimal') return issue;
    const { remedy: _r, ...rest } = issue;
    return rest;
};

export function profileIssueLine(issue: ProfileIssue): string {
    const where = [issue.service, issue.instance].filter((s): s is string => s !== undefined).join('/');
    return `${where} \`${issue.profile}\` — ${issue.kind} (${issue.confidence}): ${issue.detail}`;
}

const isArrAdapter = (a: ServiceAdapter): a is ServiceAdapter & ProfileDiagnosticsCapable =>
    (a.type === 'radarr' || a.type === 'sonarr' || a.type === 'whisparr') && hasProfileDiagnostics(a);

export async function buildGetProfileIssues(
    adapters: readonly ServiceAdapter[],
    opts: { detail: DetailLevel; limit: number; offset?: number; service?: ArrServiceType; instance?: string; profile?: string }
): Promise<GetProfileIssuesResult> {
    const arrAdapters = adapters.filter(isArrAdapter);
    const hasProfilarr = adapters.some(a => a.type === 'profilarr');

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

    const shaped = applyLimit(items, opts.limit, opts.offset);
    return {
        ...shaped,
        items: shaped.items.map(i => project(i, opts.detail)),
        degraded: degraded.sort(),
        ...(hasProfilarr ? {} : { note: DRIFT_NOT_CHECKED_NOTE })
    };
}

export const summarizeProfileIssues = (result: GetProfileIssuesResult, arrInstanceCount: number): string => {
    if (arrInstanceCount === 0) return result.note ?? '';
    if (result.degraded.length > 0 && result.degraded.length === arrInstanceCount)
        return `${result.degraded.join(', ')} could not be reached; no profile diagnostics available.`;
    const counts = `${result.returned} of ${result.total} issue(s) found${result.degraded.length > 0 ? `. ${result.degraded.join(', ')} could not be reached` : ''}.`;
    return result.note === undefined ? counts : `${counts} ${result.note}`;
};

export function registerGetProfileIssues(server: McpServer, adapters: readonly ServiceAdapter[]): void {
    server.registerTool(
        'get_profile_issues',
        {
            title: 'Profile issues',
            annotations: READ_ONLY,
            description:
                'Faults in Radarr, Sonarr and Whisparr quality profiles that Profilarr, not arr-mcp, can fix: a ' +
                'minimum custom format score nothing can reach, a score set exactly on the edge, a narrower ' +
                'language format scored while a wider one sits at zero, a language scored without a minimum to ' +
                'enforce it, and a dialect sibling left uncovered. Read-only — every `remedy` names a change to ' +
                'make in Profilarr, never one arr-mcp performs. `note` explains when nothing was configured to check.',
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
            const result = await buildGetProfileIssues(adapters, {
                detail,
                limit,
                offset,
                ...(service === undefined ? {} : { service }),
                ...(instance === undefined ? {} : { instance }),
                ...(profile === undefined ? {} : { profile })
            });
            const arrInstanceCount = adapters.filter(isArrAdapter).length;
            const summary = summarizeProfileIssues(result, arrInstanceCount);

            return {
                content: [{ type: 'text', text: listText(summary, result.items, profileIssueLine) }],
                structuredContent: result
            };
        }
    );
}
