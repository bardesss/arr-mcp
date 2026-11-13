import * as z from 'zod/v4';

/**
 * A tool call a client could offer, as data beside the prose that says the same.
 *
 * Never executed by this server: it names the call and why, and the person
 * decides. Anything that came from an upstream service stays fenced in `why`
 * and `arguments`, except values the named tool needs verbatim (ids).
 */
export type NextStep = { tool: string; arguments: Record<string, unknown>; why: string };

/** For the text block, which not every client forwards `structuredContent` beside (#234). */
export const nextStepLine = (step: NextStep): string => `Next: ${step.tool} ${JSON.stringify(step.arguments)} (${step.why})`;

/** The output-schema form of a `NextStep`, for every tool that returns `next_steps`. */
export const NextStepSchema = z.looseObject({ tool: z.string(), arguments: z.looseObject({}), why: z.string() });

/**
 * `next_steps` for a result: the same call offered once, at most `cap` of
 * them, and no key at all when there is nothing to offer, so a result with no
 * step costs a client nothing. With `count`, `next_steps_more` says how many
 * the cap left out, so a capped list does not read as the whole of it.
 */
export function stepsField(
    steps: readonly NextStep[],
    cap = 3,
    count = false
): { next_steps?: NextStep[]; next_steps_more?: number } {
    const seen = new Set<string>();
    const kept = steps.filter(step => {
        const key = `${step.tool} ${JSON.stringify(step.arguments)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    if (kept.length === 0) return {};
    const more = kept.length - cap;
    return { next_steps: kept.slice(0, cap), ...(count && more > 0 ? { next_steps_more: more } : {}) };
}
