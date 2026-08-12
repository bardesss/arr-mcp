/**
 * Answering a plain HTTP client in plain JSON.
 *
 * The streamable HTTP transport requires a POST to accept **both**
 * `application/json` and `text/event-stream`, and the SDK enforces it with a
 * `406 Not Acceptable` before the request reaches any tool. That is
 * spec-conformant and, for a stateless server that never pushes anything, it
 * buys nothing: a client that says `Accept: application/json` is refused
 * outright, and the reason it gives is a header, which reads as "this server is
 * broken" from the other end.
 *
 * That is one half of #103. The agent could not load tools, hand-rolled its own
 * HTTP calls, and its first attempt failed on the header. The second half is
 * what it got when it corrected that: an SSE frame inside a chunked body, which
 * it tried to parse as JSON and which produced `Extra data: line 1 column 4` —
 * the hex chunk-size line `2e6` parsing as the number 2×10⁶. Both halves are a
 * client that wanted one JSON object and could not get one.
 *
 * So: the request is upgraded to accept both — the tools do not care, and this
 * is the only thing standing between a working call and a 406 — and if the
 * client never asked for a stream, the SSE frame is unwrapped again on the way
 * out. The result is `application/json` with a `Content-Length`: no framing, no
 * chunk headers, nothing to misparse. The spec allows exactly this ("the server
 * MAY return `application/json`"), and a client that *does* accept
 * `text/event-stream` is left completely alone.
 *
 * What this deliberately does not do is make the server less strict about
 * anything that matters. It relaxes a transport header, not an argument, a
 * permission or a token — #103's actual lesson being that this server had those
 * exactly backwards.
 */

const STREAM = 'text/event-stream';
const JSON_TYPE = 'application/json';

/** Whether the caller is prepared to read an SSE stream. */
export const acceptsStream = (request: Request): boolean =>
    (request.headers.get('accept') ?? '').toLowerCase().includes(STREAM);

/**
 * The same request, accepting both media types.
 *
 * Headers only — the body is not touched and not read. `/mcp` always hands the
 * handler a `parsedBody` (the Hono adapter parses one from a clone), so the
 * request stream itself is never consumed here or afterwards.
 */
export function acceptingBoth(request: Request): Request {
    const headers = new Headers(request.headers);
    headers.set('accept', `${JSON_TYPE}, ${STREAM}`);
    return new Request(request, { headers });
}

/**
 * The JSON-RPC messages carried by an SSE body.
 *
 * One event may spread its payload over several `data:` lines, which the
 * protocol says to rejoin with newlines — the SDK never does, writing one line
 * per message, but a parser that only handles the shape it has seen is how the
 * next version breaks quietly.
 */
function eventPayloads(body: string): string[] {
    return body
        .split(/\r?\n\r?\n/)
        .map(event =>
            event
                .split(/\r?\n/)
                .filter(line => line.startsWith('data:'))
                .map(line => line.slice('data:'.length).trimStart())
                .join('\n')
        )
        .filter(payload => payload.length > 0);
}

/** A response, never a notification: what a caller is waiting on. */
const isResponse = (message: unknown): boolean =>
    typeof message === 'object' && message !== null && 'id' in message && !('method' in message);

/**
 * An SSE response rendered as a single JSON body.
 *
 * Anything that is not an SSE frame — a 401, the 405 on GET, an already-JSON
 * error — is returned untouched, so this can sit in front of every response
 * without knowing which ones it will need to change.
 *
 * Mid-call notifications are dropped rather than concatenated, which is what
 * the SDK's own `responseMode: 'json'` does: a caller that cannot read a stream
 * cannot be sent progress either, and appending a second JSON object to the
 * body would hand it precisely the "extra data" that made #103 unparseable.
 * If nothing in the frame is a response, the original is passed through rather
 * than being replaced by an invented one.
 */
export async function asPlainJson(response: Response): Promise<Response> {
    if (!(response.headers.get('content-type') ?? '').includes(STREAM)) return response;

    const body = await response.text();
    const messages = eventPayloads(body).flatMap(payload => {
        try {
            return [JSON.parse(payload) as unknown];
        } catch {
            return [];
        }
    });

    const responses = messages.filter(isResponse);
    if (responses.length === 0) return new Response(body, { status: response.status, headers: response.headers });

    const headers = new Headers(response.headers);
    headers.set('content-type', JSON_TYPE);
    // Set by the SSE path for proxies that would otherwise buffer a stream.
    // There is no stream now, and leaving them would describe a response this
    // no longer is.
    headers.delete('x-accel-buffering');
    headers.delete('transfer-encoding');

    // A batch in, a batch out: a caller that sent one request must not have to
    // handle an array, and one that sent several must not be handed only the
    // first.
    return new Response(JSON.stringify(responses.length === 1 ? responses[0] : responses), {
        status: response.status,
        headers
    });
}
