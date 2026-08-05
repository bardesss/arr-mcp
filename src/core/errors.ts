import type { ServiceId } from '../config/schema.ts';

export type ServiceErrorKind =
    | 'Unreachable'
    | 'AuthFailed'
    | 'NotFound'
    | 'RateLimited'
    | 'Timeout'
    | 'VersionUnsupported'
    | 'UpstreamError';

const PROSE: Record<ServiceErrorKind, string> = {
    Unreachable: 'unreachable',
    AuthFailed: 'auth failed',
    NotFound: 'not found',
    RateLimited: 'rate limited',
    Timeout: 'timed out',
    VersionUnsupported: 'version unsupported',
    UpstreamError: 'upstream error'
};

/**
 * A model told *why* something failed reports it; a model handed an opaque
 * error invents an explanation (design spec §15). `toModelText` is the only
 * string that ever reaches the model — it never includes a stack trace, and
 * never the underlying cause, which stays available for logs via `.cause`.
 */
export class ServiceError extends Error {
    readonly kind: ServiceErrorKind;
    readonly service: ServiceId;
    readonly detail: string;
    readonly remedy: string | undefined;

    constructor(
        kind: ServiceErrorKind,
        service: ServiceId,
        detail: string,
        opts?: { remedy?: string; cause?: unknown }
    ) {
        super(`${service} ${PROSE[kind]}: ${detail}`, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
        this.name = 'ServiceError';
        this.kind = kind;
        this.service = service;
        this.detail = detail;
        this.remedy = opts?.remedy;
    }

    toModelText(): string {
        const base = `${this.service} ${PROSE[this.kind]}: ${this.detail}`;
        return this.remedy ? `${base} — ${this.remedy}` : base;
    }
}

/** Extracts the path alone, so an api key in a query string cannot leak. */
function safePath(url: string): string {
    try {
        return new URL(url).pathname;
    } catch {
        return url;
    }
}

function safeHost(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

export function classifyHttpStatus(status: number, service: ServiceId, url: string): ServiceError | undefined {
    if (status < 400) return undefined;
    const at = `HTTP ${status} at ${safePath(url)}`;

    if (status === 401 || status === 403) {
        return new ServiceError('AuthFailed', service, at, {
            remedy: 'The API key is wrong. Check the service’s Settings → General page.'
        });
    }
    if (status === 404) {
        return new ServiceError('NotFound', service, at, {
            remedy: 'Wrong base path — check the URL does not include a trailing path or reverse-proxy prefix.'
        });
    }
    if (status === 429) {
        return new ServiceError('RateLimited', service, at);
    }
    return new ServiceError('UpstreamError', service, at);
}

const TLS_CODES = new Set([
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'CERT_HAS_EXPIRED',
    'ERR_TLS_CERT_ALTNAME_INVALID'
]);

export function classifyFetchError(err: unknown, service: ServiceId, url: string): ServiceError {
    const e = (err ?? {}) as {
        name?: string;
        code?: string;
        message?: string;
        cause?: { code?: string; message?: string };
    };
    // undici wraps the OS-level failure one level down as `cause`.
    const code = e.code ?? e.cause?.code;
    const host = safeHost(url);

    if (e.name === 'AbortError' || e.name === 'TimeoutError') {
        return new ServiceError('Timeout', service, `no response from ${host} within the configured timeout`, {
            cause: err
        });
    }
    if (code !== undefined && TLS_CODES.has(code)) {
        return new ServiceError('Unreachable', service, `TLS error (${code}) at ${host}`, {
            remedy:
                'The TLS certificate could not be verified. Use http:// on the LAN, or install a trusted certificate.',
            cause: err
        });
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
        return new ServiceError('Unreachable', service, `DNS lookup failed for ${host}`, {
            remedy: 'The hostname does not resolve. Use an IP address, or check your DNS.',
            cause: err
        });
    }
    if (code === 'ECONNREFUSED') {
        return new ServiceError('Unreachable', service, `connection refused at ${host}`, {
            remedy: 'Nothing is listening on that port. Check the service is running and the port is right.',
            cause: err
        });
    }
    // Windows reports a firewall-blocked outbound connection as EACCES on
    // connect, which reads nothing like a permission problem to the user.
    if (code === 'EACCES' || code === 'EPERM') {
        return new ServiceError('Unreachable', service, `connection blocked at ${host}`, {
            remedy: 'Something refused to let the connection out — usually a local firewall. Check the host can reach that address and port.',
            cause: err
        });
    }
    if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
        return new ServiceError('Unreachable', service, `no route to ${host}`, {
            remedy: 'That address is not reachable from this machine. Check the IP is right and on a network this host can see.',
            cause: err
        });
    }
    if (code === 'ETIMEDOUT') {
        // Deliberately Unreachable rather than Timeout: Timeout makes reads
        // retry once, and a connect that timed out against a dead address will
        // simply time out again, doubling the wait for no new information.
        return new ServiceError('Unreachable', service, `connection to ${host} timed out`, {
            remedy: 'Nothing answered at that address. Check the IP and port, and that a firewall is not dropping the packets.',
            cause: err
        });
    }

    // undici's own message is always the useless "fetch failed"; the cause
    // carries the one that says what actually happened.
    const detail = e.cause?.message ?? e.message ?? 'unknown error';
    return new ServiceError('Unreachable', service, `${detail} at ${host}`, { cause: err });
}
