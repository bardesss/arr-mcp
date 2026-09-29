import { ALGORITHMS } from '../mcp/oauthVerifier.ts';

export type JwksKey = { kid: string; alg: string; refused?: string };

/** A word for the log line, which must not carry a URL or anything else the
 *  issuer sent. */
export type JwksOutcome = 'unreachable' | 'redirect' | 'http' | 'too-large' | 'not-json' | 'no-keys' | 'no-usable-keys' | 'ok';

/** What the OAuth card's Test found at `jwks_uri`. `ok` means at least one key
 *  arr-mcp would verify a token with. */
export type JwksProbe = { ok: boolean; outcome: JwksOutcome; summary: string; keys: readonly JwksKey[] };

const TIMEOUT_MS = 5000;
const MAX_BYTES = 1024 * 1024;
const KEY_TYPES = ['RSA', 'EC', 'OKP'];

const fail = (outcome: JwksOutcome, summary: string): JwksProbe => ({ ok: false, outcome, summary, keys: [] });

class TooLarge extends Error {}

/** Why a fetch never got an answer, in a word or two rather than "fetch failed". */
function reason(err: unknown): string {
    if (err instanceof Error && err.name === 'TimeoutError') return `no answer within ${TIMEOUT_MS / 1000} s`;
    const code = (err as { cause?: { code?: unknown } }).cause?.code;
    if (typeof code === 'string') return code;
    return err instanceof Error ? err.message : String(err);
}

async function readCapped(res: Response): Promise<string> {
    if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) {
        await res.body?.cancel();
        throw new TooLarge();
    }
    if (res.body === null) return '';

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES) {
            await reader.cancel();
            throw new TooLarge();
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
}

function describeKey(key: unknown): JwksKey {
    if (key === null || typeof key !== 'object' || Array.isArray(key)) {
        return { kid: 'no kid', alg: 'unknown', refused: 'not a key object' };
    }
    const k = key as { kid?: unknown; alg?: unknown; kty?: unknown; use?: unknown };
    const kid = typeof k.kid === 'string' && k.kid !== '' ? k.kid : 'no kid';
    const alg = typeof k.alg === 'string' ? k.alg : typeof k.kty === 'string' ? k.kty : 'unknown';

    if (k.kty === 'oct') return { kid, alg, refused: 'symmetric (kty oct), which arr-mcp never accepts' };
    if (typeof k.kty !== 'string' || !KEY_TYPES.includes(k.kty)) {
        return { kid, alg, refused: `kty ${typeof k.kty === 'string' ? k.kty : 'missing'} is not RSA, EC or OKP` };
    }
    if (k.use !== undefined && k.use !== 'sig') {
        return { kid, alg, refused: `marked use ${String(k.use)}, not a signing key` };
    }
    if (typeof k.alg === 'string' && !ALGORITHMS.includes(k.alg)) {
        return { kid, alg, refused: `${k.alg} is not an algorithm arr-mcp accepts` };
    }
    return { kid, alg };
}

/**
 * One fetch of the key set, on the verifier's terms: jose fetches with
 * `redirect: 'manual'` and wants exactly 200, so anything looser here would be
 * a green Test for a URL `/mcp` answers with 503. Not through jose itself,
 * which folds every failure into one generic error.
 */
export async function probeJwks(uri: string): Promise<JwksProbe> {
    let res: Response;
    try {
        res = await fetch(uri, {
            signal: AbortSignal.timeout(TIMEOUT_MS),
            redirect: 'manual',
            headers: { accept: 'application/json, application/jwk-set+json' }
        });
    } catch (err) {
        return fail('unreachable', `The key set is unreachable: ${reason(err)}.`);
    }

    if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        const location = res.headers.get('location');
        return fail(
            'redirect',
            `The key set answered HTTP ${res.status} (redirects are not followed${location === null ? '' : `; use ${location}`}).`
        );
    }
    if (res.status !== 200) {
        await res.body?.cancel();
        return fail('http', `The key set answered HTTP ${res.status}.`);
    }

    let body: unknown;
    try {
        body = JSON.parse(await readCapped(res));
    } catch (err) {
        if (err instanceof TooLarge) return fail('too-large', 'The key set is larger than 1 MiB.');
        if (err instanceof SyntaxError) return fail('not-json', 'The key set answered, but the body is not JSON.');
        return fail('unreachable', `The key set is unreachable: ${reason(err)}.`);
    }

    const keys = (body as { keys?: unknown } | null)?.keys;
    if (!Array.isArray(keys) || keys.length === 0) return fail('no-keys', 'The key set has no keys.');

    const described = keys.map(describeKey);
    const usable = described.filter(k => k.refused === undefined).length;
    const found = `Found ${described.length} key${described.length === 1 ? '' : 's'}`;
    return usable > 0
        ? { ok: true, outcome: 'ok', summary: `${found}, ${usable} usable.`, keys: described }
        : {
              ok: false,
              outcome: 'no-usable-keys',
              summary: `${found}, none of which arr-mcp can verify a token with.`,
              keys: described
          };
}
