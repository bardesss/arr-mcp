import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceIdSchema } from '../../config/schema.ts';
import { buildChain, type Diagnosis } from './chain.ts';
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
            description:
                'Why is this not playable? Walks the whole chain — requested, managed, monitored, downloaded, indexed, imported, scanned — and names the first thing that explains the absence, with what to do about it. Give a title as `query` for how a person actually asks; give `service` plus `id` only when you already have an exact item in hand (e.g. from get_media_details) — the explicit id wins if both are given. Works with services down: any step it could not check sets `certain: false` and the summary says what was missed, rather than guessing across the hole.',
            inputSchema: z.object({
                query: z.string().min(1).optional().describe('A title — how a person actually asks.'),
                service: ServiceIdSchema.optional().describe('With `id`: an exact item, when one is already in hand.'),
                id: z.string().min(1).optional(),
                user: z
                    .string()
                    .min(1)
                    .optional()
                    .describe(
                        'Whose watch state to consider. Defaults to the configured default_user; any other value requires allow_other_users.'
                    )
            })
        },
        async ({ query, service, id, user }) => {
            const result = await buildDiagnose(deps, {
                ...(query === undefined ? {} : { query }),
                ...(service === undefined ? {} : { service }),
                ...(id === undefined ? {} : { id }),
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
