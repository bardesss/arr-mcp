import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceIdSchema } from '../../config/schema.ts';
import { nextStepLine } from '../../core/nextStep.ts';
import { READ_ONLY, toolInput } from '../../core/shape.ts';
import { buildChain, type Diagnosis } from './chain.ts';
import { INSTANCE_PARAM_DESCRIPTION } from '../resolveInstance.ts';
import { collectEvidence, type DiagnoseDeps, type DiagnoseTarget } from './evidence.ts';

export type { DiagnoseDeps } from './evidence.ts';

export async function buildDiagnose(deps: DiagnoseDeps, target: DiagnoseTarget): Promise<Diagnosis> {
    const evidence = await collectEvidence(deps, target);
    const label = target.query ?? `${target.service ?? ''}:${target.id ?? ''}`;
    // A lookup is only offered with the caller's own words; `label` is a service and id otherwise.
    return buildChain(label, evidence, target.query !== undefined);
}

export function registerDiagnose(server: McpServer, deps: DiagnoseDeps): void {
    server.registerTool(
        'diagnose',
        {
            title: 'Diagnose a missing or unplayable item',
            annotations: READ_ONLY,
            description:
                'Why is this not playable? Walks the chain (requested, managed, monitored, downloaded, indexed, imported, scanned) and names the first thing that explains it, with a `remedy` and, where a tool call fixes it, `next_steps` to offer the user; this tool never runs them. Give a title as `query`, or `service` plus `id` when you already hold an exact item. A title not in the library is looked up in Cleanuparr, download-client history and the library event log, so a removed release can still be explained. A step it could not check sets `certain: false`, and the summary says what was missed. [[reclaimerr: With Reclaimerr it says when a cleanup rule deleted or will delete the title;]] [[bazarr: with Bazarr it notes missing subtitles.]] [[lidarr: A Lidarr artist is walked too (tracks on disk, queue, indexers, media server): playable means at least one track, and get_media_details lists its albums.]] Field reference: arr://docs/diagnose.',
            // A verdict, not a list — so no paged envelope. `certain` is the
            // field that matters most and the one a client must not have to
            // read prose to find: a diagnosis reached across a service that
            // could not be checked is a guess, and reporting it as an answer is
            // how someone gets told their file is fine when nothing looked.
            outputSchema: z.looseObject({
                query: z.string(),
                resolved: z.looseObject({}).optional().describe('What the title resolved to. Absent when nothing matched.'),
                steps: z.array(z.unknown()).describe('The chain, in the order it runs: requested, managed, monitored, downloaded, indexed, imported, scanned.'),
                verdict: z.looseObject({
                    stage: z.string().describe('The first stage that explains the absence, or `playable`.'),
                    summary: z.string(),
                    remedy: z.string().optional(),
                    next_steps: z
                        .array(z.looseObject({ tool: z.string(), arguments: z.looseObject({}), why: z.string() }))
                        .optional()
                        .describe(
                            'The call that would act on `remedy`. Offer it to the person and say what it would do; do not run it. A write previews first and asks for confirmation.'
                        ),
                    certain: z
                        .boolean()
                        .describe('False when a step could not be checked. Report the verdict as provisional and say what was missed rather than guessing across the hole.')
                }),
                history: z.array(z.unknown()).optional().describe('Only when nothing in the library matched: the download-history row behind each release whose name matches, newest first.'),
                degraded: z.array(z.string())
            }),
            inputSchema: toolInput({
                query: z.string().min(1).optional().describe('A title — how a person actually asks.'),
                service: ServiceIdSchema.optional().describe('With `id`: an exact item, when one is already in hand.'),
                id: z.string().min(1).optional(),
                instance: z.string().min(1).optional().describe(INSTANCE_PARAM_DESCRIPTION),
                user: z
                    .string()
                    .min(1)
                    .optional()
                    .describe(
                        'Whose watch state to consider. Defaults to the configured default_user; any other value requires allow_other_users.'
                    )
            })
        },
        async ({ query, service, id, instance, user }) => {
            const result = await buildDiagnose(deps, {
                ...(query === undefined ? {} : { query }),
                ...(service === undefined ? {} : { service }),
                ...(id === undefined ? {} : { id }),
                ...(instance === undefined ? {} : { instance }),
                ...(user === undefined ? {} : { user })
            });

            const confidence = result.verdict.certain ? '' : ' (uncertain)';
            // In the text as well, because not every client forwards structuredContent (#234).
            const text = `${result.verdict.summary}${confidence}${
                result.verdict.remedy === undefined ? '' : ` ${result.verdict.remedy}`
            }${(result.verdict.next_steps ?? []).map(step => `\n${nextStepLine(step)}`).join('')}`;

            return { content: [{ type: 'text', text }], structuredContent: result };
        }
    );
}
