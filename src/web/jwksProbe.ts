import { ALGORITHMS } from '../mcp/oauthVerifier.ts';

export type JwksKey = { kid: string; alg: string; refused?: string };

/** What the OAuth card's Test found at `jwks_uri`. `ok` means at least one key
 *  arr-mcp would verify a token with. */
export type JwksProbe = { ok: boolean; summary: string; keys: readonly JwksKey[] };

const TIMEOUT_MS = 5000;

const fail = (summary: string): JwksProbe => ({ ok: false, summary, keys: [] });

/** Why a fetch never got an answer, in a word or two rather than "fetch failed". */
function reason(err: unknown): string {
    if (err instanceof Error && err.name === 'TimeoutError') return `no answer within ${TIMEOUT_MS / 1000} s`;
    const code = (err as { cause?: { code?: unknown } }).cause?.code;
    if (typeof code === 'string') return code;
    return err instanceof Error ? err.message : String(err);
}

function describeKey(key: unknown): JwksKey {
    const k = (key ?? {}) as { kid?: unknown; alg?: unknown; kty?: unknown };
    const kid = typeof k.kid === 'string' && k.kid !== '' ? k.kid : 'no kid';
    const alg = typeof k.alg === 'string' ? k.alg : typeof k.kty === 'string' ? k.kty : 'unknown';

    if (k.kty === 'oct') return { kid, alg, refused: 'symmetric (kty oct), which arr-mcp never accepts' };
    if (typeof k.alg === 'string' && !ALGORITHMS.includes(k.alg)) {
        return { kid, alg, refused: `${k.alg} is not an algorithm arr-mcp accepts` };
    }
    return { kid, alg };
}

/**
 * One fetch of the key set, reported the way the verifier would see it. Not
 * through jose: `createRemoteJWKSet` folds every one of these failures into a
 * generic error, and this exists to tell them apart.
 */
export async function probeJwks(uri: string): Promise<JwksProbe> {
    let res: Response;
    try {
        res = await fetch(uri, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
    } catch (err) {
        return fail(`The key set is unreachable: ${reason(err)}.`);
    }
    if (!res.ok) return fail(`The key set answered HTTP ${res.status}.`);

    let body: unknown;
    try {
        body = await res.json();
    } catch {
        return fail('The key set answered, but the body is not JSON.');
    }

    const keys = (body as { keys?: unknown } | null)?.keys;
    if (!Array.isArray(keys) || keys.length === 0) return fail('The key set has no keys.');

    const described = keys.map(describeKey);
    const usable = described.filter(k => k.refused === undefined).length;
    return {
        ok: usable > 0,
        summary:
            usable > 0
                ? `Found ${described.length} key${described.length === 1 ? '' : 's'}, ${usable} usable.`
                : `Found ${described.length} key${described.length === 1 ? '' : 's'}, none of which arr-mcp can verify a token with.`,
        keys: described
    };
}
