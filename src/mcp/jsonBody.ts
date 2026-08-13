/**
 * Reading the request body, so a failure to read it is still JSON.
 *
 * The request-side half of `plainJson.ts`. That one makes sure a client asking
 * for JSON is *answered* in JSON; this one makes sure it is *refused* in JSON,
 * which was the last path where it was not.
 *
 * The Hono adapter installs its own body parser for anything declaring
 * `application/json`, and a body it cannot parse is answered `400 Invalid
 * JSON` as `text/plain`. That happens before the request reaches the transport,
 * so nothing downstream can improve on it — and it is the same failure as the
 * 406 that started #103: a caller that spoke JSON, was answered in something
 * else, and had no parser for the reason it was given. `-32700` is the code the
 * JSON-RPC spec already reserves for exactly this, and costs the same bytes.
 *
 * It also unblocks a body-less GET. Plenty of HTTP clients set a default
 * `Content-Type: application/json` on every request they make, including the
 * one probing `GET /mcp` for a stream. The adapter parsed the absent body,
 * failed, and answered 400 for a body that was never claimed to exist, hiding
 * the 405 that actually describes this endpoint.
 *
 * The mechanism is the adapter's own opt-out: it skips a request whose
 * `parsedBody` is already set, so claiming the body first is enough to own the
 * failure. Which is also the constraint — this must be registered before the
 * adapter's middleware, and `app.ts` mounts it on an outer app for that reason.
 */

import { isJsonContentType } from '@modelcontextprotocol/server';
import type { Context, Next } from 'hono';

/**
 * The JSON-RPC parse error. `id` is null because there is no parsed body to
 * read one from — which is what the spec says to send when the request could
 * not be understood well enough to identify it.
 */
const PARSE_ERROR = {
    jsonrpc: '2.0',
    id: null,
    error: { code: -32700, message: 'Parse error: the request body is not valid JSON.' }
} as const;

/**
 * Claims the JSON body before the adapter's parser can refuse it in plain text.
 *
 * A request that does not declare JSON is left completely alone: a POST with
 * `text/plain`, or with no content type at all, is the transport's to refuse
 * and it already answers 415 in JSON. Parsing it here would replace that with a
 * parse error, which names the wrong problem — the body is not the complaint,
 * the media type is.
 */
export async function claimJsonBody(c: Context, next: Next): Promise<Response | void> {
    if (!isJsonContentType(c.req.header('content-type'))) return next();

    // A GET or DELETE carries no body to parse. Setting the field to null
    // rather than leaving it unset is what makes the adapter skip it — the
    // check there is `!== undefined` — and `/mcp` maps it back to `undefined`
    // so the transport still sees a request with no body and answers 405.
    if (c.req.method !== 'POST') {
        c.set('parsedBody', null);
        return next();
    }

    try {
        // Cloned, like the adapter's own parser: the transport reads the
        // request stream itself on any path that does not hand it a body.
        c.set('parsedBody', await c.req.raw.clone().json());
    } catch {
        return c.json(PARSE_ERROR, 400);
    }

    return next();
}
