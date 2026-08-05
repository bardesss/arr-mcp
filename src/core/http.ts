import type { BaseServiceConfig, ServiceId } from '../config/schema.ts';
import type { AuthStrategy } from './auth.ts';
import { ServiceError, classifyFetchError, classifyHttpStatus } from './errors.ts';
import { logger } from './logger.ts';

export const CIRCUIT_THRESHOLD = 5;
export const CIRCUIT_COOLDOWN_MS = 60_000;

/**
 * The one implementation of design spec §15's resilience policy. Eight
 * adapters sharing this is what makes "the breaker opens after five failures"
 * a checkable property of the stack rather than a property of Radarr.
 */
export class ServiceHttp {
    readonly #id: ServiceId;
    readonly #baseUrl: string;
    readonly #timeoutMs: number;
    readonly #auth: AuthStrategy;
    readonly #fetch: typeof fetch;

    #consecutiveFailures = 0;
    #openedAt: number | undefined;

    constructor(id: ServiceId, config: BaseServiceConfig, auth: AuthStrategy, fetchImpl: typeof fetch = fetch) {
        this.#id = id;
        this.#baseUrl = config.url;
        this.#timeoutMs = config.timeout_ms;
        this.#auth = auth;
        this.#fetch = fetchImpl;
    }

    /** Reads retry once on timeout (design spec §15). */
    async get<T>(path: string): Promise<T> {
        return this.#request<T>('GET', path, undefined, true);
    }

    /** Writes never auto-retry — a retried add_media is a double-add. */
    async post<T>(path: string, body: unknown): Promise<T> {
        return this.#request<T>('POST', path, body, false);
    }

    // --- internals ---

    async #request<T>(method: string, path: string, body: unknown, retryOnTimeout: boolean): Promise<T> {
        if (this.#circuitOpen()) {
            throw new ServiceError(
                'Unreachable',
                this.#id,
                `circuit breaker is open after ${CIRCUIT_THRESHOLD} consecutive failures`,
                { remedy: `Not retried for ${CIRCUIT_COOLDOWN_MS / 1000}s. Fix the service, then try again.` }
            );
        }

        try {
            const result = await this.#attempt<T>(method, path, body);
            this.#recordSuccess();
            return result;
        } catch (err) {
            if (retryOnTimeout && err instanceof ServiceError && err.kind === 'Timeout') {
                try {
                    const result = await this.#attempt<T>(method, path, body);
                    this.#recordSuccess();
                    return result;
                } catch (retryErr) {
                    this.#recordFailure();
                    throw retryErr;
                }
            }
            this.#recordFailure();
            throw err;
        }
    }

    /**
     * One logical attempt. An auth strategy may consume one transport-level
     * recovery inside it — Transmission's 409 handshake — which by construction
     * neither consumes the timeout retry above nor reaches the breaker.
     */
    async #attempt<T>(method: string, path: string, body: unknown, allowRecovery = true): Promise<T> {
        const url = new URL(path, this.#baseUrl);
        const headers = new Headers({ Accept: 'application/json' });
        if (body !== undefined) headers.set('content-type', 'application/json');

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
                ...(body === undefined ? {} : { body: JSON.stringify(body) })
            });
        } catch (err) {
            throw classifyFetchError(err, this.#id, safeUrl);
        }

        if (allowRecovery && this.#auth.recover?.(response) === true) {
            return this.#attempt<T>(method, path, body, false);
        }

        const httpError = classifyHttpStatus(response.status, this.#id, safeUrl);
        if (httpError) throw httpError;

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
