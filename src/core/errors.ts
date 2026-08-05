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

function formatServiceError(kind: ServiceErrorKind, service: ServiceId, detail: string, remedy?: string): string {
    const base = `${service} ${PROSE[kind]}: ${detail}`;
    return remedy ? `${base} — ${remedy}` : base;
}

/**
 * A model told *why* something failed reports it; a model handed an opaque
 * error invents an explanation (design spec §15). The remedy therefore lives
 * in `.message` itself, not only in `toModelText()`: every path that throws
 * this error is caught somewhere as a plain `Error`, and the only field a
 * generic catcher reads is `.message` — including the MCP SDK's own tool
 * dispatch loop, which builds its error result from `error.message` alone.
 * `.message` never includes a stack trace, and never the underlying cause,
 * which stays available for logs via `.cause`.
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
        super(
            formatServiceError(kind, service, detail, opts?.remedy),
            opts?.cause !== undefined ? { cause: opts.cause } : undefined
        );
        this.name = 'ServiceError';
        this.kind = kind;
        this.service = service;
        this.detail = detail;
        this.remedy = opts?.remedy;
    }

    /**
     * Now identical to `.message` — kept as the named, documented surface so
     * a call site reads as "the text a model may see" rather than "whatever
     * `Error.prototype` happens to expose".
     */
    toModelText(): string {
        return this.message;
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

/**
 * The only signal a 404 carries about *why* is the path it was for. Every
 * real by-id endpoint in this codebase (Radarr `/api/v3/movie/{id}`, Sonarr
 * `/api/v3/series/{id}`) ends the path in a bare integer; every collection or
 * status endpoint (`/api/v3/movie`, `/api/v3/system/status`) ends in a plain
 * word. A trailing segment that is neither — a GUID, a hash, a slug — is
 * genuinely ambiguous from the path alone, so it gets a remedy that says so
 * instead of confidently guessing one cause.
 */
function classifyNotFoundPath(pathname: string): 'item' | 'collection' | 'ambiguous' {
    const last = pathname.split('/').filter(Boolean).at(-1);
    if (last === undefined) return 'collection';
    if (/^\d+$/.test(last)) return 'item';
    if (/^[A-Za-z]+$/.test(last)) return 'collection';
    return 'ambiguous';
}

const NOT_FOUND_REMEDY: Record<ReturnType<typeof classifyNotFoundPath>, string> = {
    item: 'This id does not exist at that service — verify it (e.g. via search) rather than a guess, before assuming the base URL is wrong.',
    collection: 'Wrong base path — check the URL does not include a trailing path or reverse-proxy prefix.',
    ambiguous:
        'Could not tell from the URL alone whether this is a missing id or a wrong base path — verify the id is correct, and separately that the URL has no trailing path or reverse-proxy prefix.'
};

export function classifyHttpStatus(status: number, service: ServiceId, url: string): ServiceError | undefined {
    if (status < 400) return undefined;
    const pathname = safePath(url);
    const at = `HTTP ${status} at ${pathname}`;

    if (status === 401 || status === 403) {
        return new ServiceError('AuthFailed', service, at, {
            remedy: 'The API key is wrong. Check the service’s Settings → General page.'
        });
    }
    if (status === 404) {
        return new ServiceError('NotFound', service, at, {
            remedy: NOT_FOUND_REMEDY[classifyNotFoundPath(pathname)]
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
