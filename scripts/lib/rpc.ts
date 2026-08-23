/**
 * One `tools/call` JSON-RPC request, in-process through Hono — no listening
 * port.
 *
 * Shared because there were three hand-written copies of it: `integration.ts`,
 * `multi-instance-check.ts` and `test/app.test.ts`'s `rpcPayload`. All three
 * carry the same assumption about how the SDK frames a response, and three
 * copies of an assumption is three places for it to drift.
 *
 * Throws on any transport- or protocol-level failure — a non-2xx HTTP status,
 * an unparsable body, or a JSON-RPC `error`. A *tool*-level failure is not one
 * of these: it comes back as a normal 200 with `isError: true`, which the
 * caller inspects.
 */

import type { Hono } from 'hono';

export type ToolCallResult = {
    isError?: boolean;
    content?: { type: string; text?: string }[];
    structuredContent?: unknown;
};

/** The real app. All three callers drive `buildApp`'s output. */
type Requestable = Pick<Hono, 'request'>;

let nextId = 1;

/**
 * The SDK may frame the body as SSE rather than plain JSON, and the payload is
 * always the one top-level JSON object in it. Slicing between the first `{`
 * and the last `}` is what handles both without parsing the SSE envelope.
 */
export function rpcPayload<T>(text: string): { result?: T; error?: { code?: number; message?: string } } {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('transport error: no JSON-RPC payload in the response body');
    // `code` as well as `message`: the 2026-07-28 revision distinguishes
    // refusals by number — -32020 for a missing `Mcp-Method`, -32601 for the
    // removed `ping` — and a caller cannot tell those apart from prose.
    return JSON.parse(text.slice(start, end + 1)) as { result?: T; error?: { code?: number; message?: string } };
}

export async function callTool(
    app: Requestable,
    token: string,
    name: string,
    args: Record<string, unknown>
): Promise<ToolCallResult> {
    const res = await app.request('http://localhost:6060/mcp', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } })
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`transport error: HTTP ${res.status}`);

    const payload = rpcPayload<ToolCallResult>(text);
    if (payload.error !== undefined) throw new Error(`protocol error: ${payload.error.message ?? 'unnamed'}`);
    if (payload.result === undefined) throw new Error('protocol error: no result in the response');
    return payload.result;
}
