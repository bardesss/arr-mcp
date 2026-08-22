import type { BaseServiceConfig } from '../config/schema.ts';
import type { AuthStrategy } from './auth.ts';
import { ServiceError, classifyFetchError, classifyHttpStatus } from './errors.ts';
import { logger } from './logger.ts';

export const CIRCUIT_THRESHOLD = 5;
export const CIRCUIT_COOLDOWN_MS = 60_000;

/** JSON everywhere but qBittorrent, whose WebUI takes form fields. */
type RequestBody = { readonly json: unknown } | { readonly form: Record<string, string> };

/** `text` for qBittorrent's `/api/v2/app/version`, which answers `v5.0.4` —
 *  a bare string that is not valid JSON. */
type ReadAs = 'json' | 'text' | 'none';

/**
 * Release a response nobody will read.
 *
 * undici keeps the connection checked out until the body is consumed or
 * cancelled, so an unread error body pinned it until garbage collection. Never
 * throws: this is cleanup on a path that already has a real outcome to report.
 */
const discard = async (response: Response): Promise<void> => {
    try {
        await response.body?.cancel();
    } catch {
        // A body already consumed or already errored needs no releasing.
    }
};

const encodeBody = (body: RequestBody): { contentType: string; payload: string } =>
    'form' in body
        ? { contentType: 'application/x-www-form-urlencoded', payload: new URLSearchParams(body.form).toString() }
        : { contentType: 'application/json', payload: JSON.stringify(body.json) };

/**
 * The one implementation of the resilience policy. Nine
 * adapters sharing this is what makes "the breaker opens after five failures"
 * a checkable property of the stack rather than a property of Radarr.
 */
export class ServiceHttp {
    readonly #id: string;
    readonly #baseUrl: string;
    readonly #basePath: string;
    readonly #timeoutMs: number;
    readonly #auth: AuthStrategy;
    readonly #fetch: typeof fetch;

    #consecutiveFailures = 0;
    #openedAt: number | undefined;

    constructor(id: string, config: BaseServiceConfig, auth: AuthStrategy, fetchImpl: typeof fetch = fetch) {
        this.#id = id;
        this.#baseUrl = config.url;
        this.#basePath = new URL(config.url).pathname.replace(/\/+$/, '');
        this.#timeoutMs = config.timeout_ms;
        this.#auth = auth;
        this.#fetch = fetchImpl;
    }

    /** Reads retry once on timeout. */
    async get<T>(path: string): Promise<T> {
        return this.#request<T>('GET', path, undefined, true);
    }

    /** A read whose response is a bare string rather than JSON. */
    async getText(path: string): Promise<string> {
        return this.#request<string>('GET', path, undefined, true, 'text');
    }

    /**
     * A GET that is not a read, and so must not be retried.
     *
     * The retry policy above is keyed on the verb, which holds for every
     * service but SABnzbd — whose entire API is GET, queue deletions included.
     * That one write inherited the read retry: a delete that timed out *after*
     * SABnzbd had processed it was sent again, and the second attempt answers
     * `{"status": false}` for an nzo_id that is already gone, which the
     * adapter reports as "the delete was refused". A successful deletion,
     * reported as a failure, with the item genuinely gone.
     */
    async getAsWrite<T>(path: string): Promise<T> {
        return this.#request<T>('GET', path, undefined, false);
    }

    /**
     * Writes never auto-retry — a retried add_media is a double-add.
     *
     * `discardBody` for the same reason `put` and `delete` carry it: Jellyfin
     * answers a started library scan with 204 and no body, and parsing that as
     * JSON turned a scan already underway into "response was not valid JSON" —
     * a failure report for work that had succeeded, inviting a retry that
     * would start it a second time.
     */
    async post<T>(path: string, body: unknown, discardBody = false): Promise<T> {
        return this.#request<T>(
            'POST',
            path,
            body === undefined ? undefined : { json: body },
            false,
            discardBody ? 'none' : 'json'
        );
    }

    /** qBittorrent's writes are form-encoded POSTs. Never auto-retried. */
    async postForm<T>(path: string, fields: Record<string, string>, discardBody = false): Promise<T> {
        return this.#request<T>('POST', path, { form: fields }, false, discardBody ? 'none' : 'json');
    }

    /**
     * Like every write, never auto-retried. `discardBody` because Sonarr's
     * `/episode/monitor` answers with an empty 200 — routing that through the
     * JSON parse would turn a successful write into "response was not valid
     * JSON", the same trap `delete` already documents.
     */
    async put<T>(path: string, body: unknown, discardBody = false): Promise<T> {
        return this.#request<T>(
            'PUT',
            path,
            body === undefined ? undefined : { json: body },
            false,
            discardBody ? 'none' : 'json'
        );
    }

    /**
     * Deletes return no body worth reading — Radarr and Sonarr answer 200 with
     * an empty one — so this discards it rather than parsing it. Typing it
     * `void` is the honest signature: a `delete<T>` would invite a caller to
     * read fields that are never there, and routing a delete through `post`'s
     * JSON parse turns every successful deletion into "response was not valid
     * JSON".
     *
     * Like every write, it never auto-retries.
     */
    async delete(path: string): Promise<void> {
        await this.#request<unknown>('DELETE', path, undefined, false, 'none');
    }

    /** Bazarr's subtitle actions are PATCH with everything in the query string,
     *  answered with an empty 204. Like every write, never auto-retried. */
    async patch(path: string): Promise<void> {
        await this.#request<unknown>('PATCH', path, undefined, false, 'none');
    }

    /** Sonarr's bulk episode-file delete is a DELETE *with* a body, which
     *  `delete` cannot express. Same no-retry, same discarded body. */
    async deleteWithBody(path: string, body: unknown): Promise<void> {
        await this.#request<unknown>('DELETE', path, { json: body }, false, 'none');
    }

    // --- internals ---

    async #request<T>(
        method: string,
        path: string,
        body: RequestBody | undefined,
        retryOnTimeout: boolean,
        read: ReadAs = 'json'
    ): Promise<T> {
        if (this.#circuitOpen()) {
            throw new ServiceError(
                'Unreachable',
                this.#id,
                `circuit breaker is open after ${CIRCUIT_THRESHOLD} consecutive failures`,
                { remedy: `Not retried for ${CIRCUIT_COOLDOWN_MS / 1000}s. Fix the service, then try again.` }
            );
        }

        try {
            const result = await this.#attempt<T>(method, path, body, true, read);
            this.#recordSuccess();
            return result;
        } catch (err) {
            if (retryOnTimeout && err instanceof ServiceError && err.kind === 'Timeout') {
                try {
                    const result = await this.#attempt<T>(method, path, body, true, read);
                    this.#recordSuccess();
                    return result;
                } catch (retryErr) {
                    this.#record(retryErr);
                    throw retryErr;
                }
            }
            this.#record(err);
            throw err;
        }
    }

    /**
     * Whether a failed call is evidence the *service* is unwell.
     *
     * A 404 is not. Looking up ids that do not exist is an ordinary
     * per-request outcome, and a service that answers one has plainly
     * answered — so it counts as a success here, which is what stops five
     * missing-id lookups in a row making a healthy Radarr unreachable for the
     * whole cooldown, calls that would have worked included.
     */
    #record(err: unknown): void {
        if (err instanceof ServiceError && err.kind === 'NotFound') this.#recordSuccess();
        else this.#recordFailure();
    }

    /**
     * One logical attempt. An auth strategy may consume one transport-level
     * recovery inside it — Transmission's 409 handshake — which by construction
     * neither consumes the timeout retry above nor reaches the breaker.
     */
    async #attempt<T>(
        method: string,
        path: string,
        body: RequestBody | undefined,
        allowRecovery = true,
        read: ReadAs = 'json'
    ): Promise<T> {
        // Prefixed, not resolved: every adapter path is absolute, and `new URL`
        // given an absolute path throws the base's own path away — which is how
        // a service behind a URL base got its requests sent to the host root.
        const url = new URL(this.#basePath + path, this.#baseUrl);
        const headers = new Headers({ Accept: read === 'text' ? '*/*' : 'application/json' });
        const encoded = body === undefined ? undefined : encodeBody(body);
        if (encoded !== undefined) headers.set('content-type', encoded.contentType);

        this.#auth.apply({ url, headers, method });

        // Origin and path only, never the full URL: a query-parameter auth
        // strategy puts the API key in the search string, and this value
        // reaches the model inside an error message.
        const safeUrl = `${new URL(this.#baseUrl).origin}${url.pathname}`;

        let response: Response;
        try {
            response = await this.#fetch(url.toString(), {
                method,
                headers,
                signal: AbortSignal.timeout(this.#timeoutMs),
                ...(encoded === undefined ? {} : { body: encoded.payload })
            });
        } catch (err) {
            throw classifyFetchError(err, this.#id, safeUrl);
        }

        let recovered = false;
        if (allowRecovery && this.#auth.recover !== undefined) {
            try {
                recovered = (await this.#auth.recover(response)) === true;
            } catch (err) {
                // A recover that throws leaves the original response unread on
                // every other path out of this function.
                await discard(response);
                throw err;
            }
        }

        if (recovered) {
            // Nothing will read this one — the retry below supersedes it — and
            // an unread body pins its keep-alive connection until GC. A burst
            // of Transmission 409s or qBittorrent 403s otherwise degraded
            // connection reuse for everything behind the same origin.
            await discard(response);
            return this.#attempt<T>(method, path, body, false, read);
        }

        const httpError = classifyHttpStatus(response.status, this.#id, safeUrl);
        if (httpError) {
            await discard(response);
            throw httpError;
        }

        // The status line already said it worked, and nothing reads what comes
        // back. Parsing it anyway is how a successful delete becomes an error.
        if (read === 'none') {
            await discard(response);
            return undefined as T;
        }
        if (read === 'text') return (await response.text()).trim() as T;

        try {
            return (await response.json()) as T;
        } catch (err) {
            throw new ServiceError('UpstreamError', this.#id, `response from ${url.pathname} was not valid JSON`, {
                cause: err
            });
        }
    }

    #circuitOpen(): boolean {
        if (this.#openedAt === undefined) return false;
        if (Date.now() - this.#openedAt >= CIRCUIT_COOLDOWN_MS) {
            // Half-open: admit a single trial request. Leaving the count one
            // below the threshold means one more failure re-opens immediately.
            this.#openedAt = undefined;
            this.#consecutiveFailures = CIRCUIT_THRESHOLD - 1;
            return false;
        }
        return true;
    }

    #recordSuccess(): void {
        this.#consecutiveFailures = 0;
        this.#openedAt = undefined;
    }

    #recordFailure(): void {
        this.#consecutiveFailures += 1;
        if (this.#consecutiveFailures >= CIRCUIT_THRESHOLD && this.#openedAt === undefined) {
            this.#openedAt = Date.now();
            logger.warn({ service: this.#id }, 'circuit breaker opened after consecutive failures');
        }
    }
}
