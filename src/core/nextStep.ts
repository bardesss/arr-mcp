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
