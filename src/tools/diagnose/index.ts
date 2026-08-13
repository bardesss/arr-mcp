import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceIdSchema } from '../../config/schema.ts';
import { READ_ONLY, toolInput } from '../../core/shape.ts';
import { buildChain, type Diagnosis } from './chain.ts';
import { INSTANCE_PARAM_DESCRIPTION } from '../resolveInstance.ts';
import { collectEvidence, type DiagnoseDeps, type DiagnoseTarget } from './evidence.ts';

export type { DiagnoseDeps } from './evidence.ts';

export async function buildDiagnose(deps: DiagnoseDeps, target: DiagnoseTarget): Promise<Diagnosis> {
    const evidence = await collectEvidence(deps, target);
    const label = target.query ?? `${target.service ?? ''}:${target.id ?? ''}`;
    return buildChain(label, evidence);
}

export function registerDiagnose(server: McpServer, deps: DiagnoseDeps): void {
    server.registerTool(
        'diagnose',
        {
            title: 'Diagnose a missing or unplayable item',
            annotations: READ_ONLY,
            description:
                'Why is this not playable? Walks the whole chain — requested, managed, monitored, downloaded, indexed, imported, scanned — and names the first thing that explains the absence, with what to do about it. Give a title as `query` for how a person actually asks; give `service` plus `id` only when you already have an exact item in hand (e.g. from get_media_details) — the explicit id wins if both are given. Works with services down: any step it could not check sets `certain: false` and the summary says what was missed, rather than guessing across the hole.',
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
                    certain: z
                        .boolean()
                        .describe('False when a step could not be checked. Report the verdict as provisional and say what was missed rather than guessing across the hole.')
                }),
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
            const text = `${result.verdict.summary}${confidence}${
                result.verdict.remedy === undefined ? '' : ` ${result.verdict.remedy}`
            }`;

            return { content: [{ type: 'text', text }], structuredContent: result };
        }
    );
}
