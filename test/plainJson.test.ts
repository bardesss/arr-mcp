import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { ConfigSchema, type Config } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { LogStore } from '../src/core/logs.ts';
import { Runtime } from '../src/core/runtime.ts';
import { hashPassword } from '../src/core/session.ts';
import { acceptingBoth, acceptsStream, asPlainJson } from '../src/mcp/plainJson.ts';

/**
 * The transport half of #103, which cost the reporter two failures before they
 * reached a tool at all.
 *
 * A POST saying `Accept: application/json` was refused with `406 Not
 * Acceptable` — spec-conformant, and worth nothing on a stateless server that
 * never pushes. Correcting the header then produced an SSE frame inside a
 * chunked body, whose hex chunk-size line (`2e6`) parses as the number 2×10⁶
 * and yields `Extra data: line 1 column 4 (char 3)` — the exact error in the
 * issue, reported there as "duplicate JSON".
 *
 * Neither is a protocol violation on this server's part. Both are a client
 * asking for one JSON object and not being able to get one.
 */

const TOKEN = 'a'.repeat(64);

const config: Config = ConfigSchema.parse({
    auth: { bearer_token: TOKEN, password_hash: hashPassword('unused-here') },
    services: {}
});

const app = () =>
    buildApp({
        runtime: Runtime.fromConfig(config, WriteAudit.ephemeral(), { adapters: [] }),
        audit: WriteAudit.ephemeral(),
        logs: LogStore.ephemeral()
    });

const post = (accept: string | undefined, body: unknown) =>
    app().request('http://localhost:6060/mcp', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${TOKEN}`,
            ...(accept === undefined ? {} : { Accept: accept })
        },
        body: JSON.stringify(body)
    });

const toolsList = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

describe('a client that asks for JSON gets JSON', () => {
    it('answers `Accept: application/json` instead of refusing it with a 406', async () => {
        const res = await post('application/json', toolsList);

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('application/json');
    });

    /**
     * The whole point: `JSON.parse` on the raw body, with nothing stripped
     * first. This is the call that produced "Extra data: line 1 column 4".
     */
    it('returns a body that parses as one JSON object, with no framing to strip', async () => {
        const body = await (await post('application/json', toolsList)).text();

        expect(body.startsWith('event:')).toBe(false);
        expect(body).not.toContain('data:');
        const payload = JSON.parse(body) as { result: { tools: unknown[] } };
        expect(payload.result.tools.length).toBeGreaterThan(0);
    });

    it('answers a request with no Accept header at all', async () => {
        const res = await post(undefined, toolsList);
        expect(res.status).toBe(200);
        expect(JSON.parse(await res.text())).toHaveProperty('result');
    });

    it('answers `Accept: */*`, which the transport counts as neither type', async () => {
        expect((await post('*/*', toolsList)).status).toBe(200);
    });

    /**
     * The transport requires *both* media types, so a client asking only for a
     * stream was refused as well. It gets its stream.
     */
    it('answers `Accept: text/event-stream` alone, and still frames it as a stream', async () => {
        const res = await post('text/event-stream', toolsList);

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/event-stream');
        expect(await res.text()).toContain('event: message');
    });

    it('leaves a client that accepts both exactly as it was', async () => {
        const res = await post('application/json, text/event-stream', toolsList);

        expect(res.headers.get('content-type')).toContain('text/event-stream');
        expect(await res.text()).toContain('data:');
    });

    it('carries a tool call through, structured content and all', async () => {
        const res = await post('application/json', {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'get_library', arguments: { limit: 5 } }
        });

        const payload = JSON.parse(await res.text()) as {
            result: { structuredContent: { total: number; offset: number } };
        };
        expect(payload.result.structuredContent).toMatchObject({ total: 0, offset: 0 });
    });

    /** Authentication runs first and answers in JSON already; unwrapping must
     *  not touch it, or a 401 would arrive as a 200. */
    it('does not disturb a 401', async () => {
        const res = await app().request('http://localhost:6060/mcp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(toolsList)
        });

        expect(res.status).toBe(401);
        expect(JSON.parse(await res.text())).toEqual({ error: 'unauthorized' });
    });

    /** A notification has no response to unwrap. It must stay a bare 202. */
    it('leaves a notification acknowledged with 202 and an empty body', async () => {
        const res = await post('application/json', { jsonrpc: '2.0', method: 'notifications/initialized' });

        expect(res.status).toBe(202);
        expect(await res.text()).toBe('');
    });
});

describe('unwrapping an SSE frame', () => {
    const sse = (body: string) =>
        new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'x-accel-buffering': 'no' } });

    it('leaves a response that is not a stream completely alone', async () => {
        const json = new Response('{"a":1}', { status: 418, headers: { 'content-type': 'application/json' } });
        const out = await asPlainJson(json);

        expect(out.status).toBe(418);
        expect(await out.text()).toBe('{"a":1}');
    });

    it('drops the headers that described a stream this no longer is', async () => {
        const out = await asPlainJson(sse('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n'));

        expect(out.headers.get('content-type')).toContain('application/json');
        expect(out.headers.get('x-accel-buffering')).toBeNull();
    });

    /**
     * A payload may span several `data:` lines, rejoined with newlines. The SDK
     * writes one line per message today; a parser that only handles the shape
     * it has seen is how the next version breaks quietly.
     */
    it('rejoins a payload split across several data lines', async () => {
        const out = await asPlainJson(sse('event: message\ndata: {"jsonrpc":"2.0","id":1,\ndata: "result":{"ok":true}}\n\n'));

        expect(JSON.parse(await out.text())).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    });

    /**
     * Mid-call notifications are dropped rather than concatenated — appending a
     * second object to the body is precisely the "extra data" that made #103
     * unparseable, and a caller that cannot read a stream cannot read progress
     * either.
     */
    it('keeps the response and drops a notification that arrived before it', async () => {
        const frame =
            'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n' +
            'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n';
        const out = await asPlainJson(sse(frame));

        expect(JSON.parse(await out.text())).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
    });

    /** A batch in, a batch out. */
    it('returns an array when the frame carried several responses', async () => {
        const frame =
            'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n' +
            'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{}}\n\n';
        const out = await asPlainJson(sse(frame));

        expect(JSON.parse(await out.text())).toHaveLength(2);
    });

    /** Nothing to unwrap: pass the original through rather than invent one. */
    it('passes a frame carrying no response through unchanged', async () => {
        const frame = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\n\n';
        const out = await asPlainJson(sse(frame));

        expect(await out.text()).toBe(frame);
    });
});

describe('reading and rewriting the Accept header', () => {
    const request = (accept?: string) =>
        new Request('http://localhost:6060/mcp', {
            method: 'POST',
            headers: accept === undefined ? {} : { Accept: accept }
        });

    it('recognises a stream client however the header is cased or ordered', () => {
        expect(acceptsStream(request('TEXT/EVENT-STREAM'))).toBe(true);
        expect(acceptsStream(request('application/json, text/event-stream;q=0.9'))).toBe(true);
        expect(acceptsStream(request('application/json'))).toBe(false);
        expect(acceptsStream(request())).toBe(false);
        expect(acceptsStream(request('*/*'))).toBe(false);
    });

    it('rewrites only the header, leaving method and url alone', () => {
        const upgraded = acceptingBoth(request('application/json'));

        expect(upgraded.headers.get('accept')).toBe('application/json, text/event-stream');
        expect(upgraded.method).toBe('POST');
        expect(upgraded.url).toBe('http://localhost:6060/mcp');
    });
});
