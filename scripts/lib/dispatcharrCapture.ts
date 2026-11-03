/**
 * Dispatcharr row scrubbing for `capture-fixtures.ts`, split out so it can be
 * unit tested: `capture-fixtures.ts` runs `loadConfig()` on import.
 *
 * Fixture policy is stricter than for the *arr blocks: an M3U account's
 * `server_url`, `username` and `password` are an IPTV subscription's
 * credentials, and Dispatcharr returns the password to admins. They are
 * blanked, never replaced with a plausible stand-in, and `last_message`
 * (which embeds the provider URL and reply) is rewritten in the same shape.
 */
import { isRow, type Row } from './redact.ts';

/** Never kept with a value: credentials, hosts and paths. */
const SECRET_KEYS = ['password', 'username', 'server_url', 'url', 'file_path', 'search_pattern', 'replace_pattern'] as const;
const STAND_IN_URL = 'http://provider.example/get.php?username=u&password=p';

function scrubMessage(message: string): string {
    const at = message.indexOf('URL:');
    if (at >= 0) return `${message.slice(0, at)}URL: ${STAND_IN_URL}. Server message: example`;
    const forUrl = message.indexOf('for url:');
    if (forUrl >= 0) return `${message.slice(0, forUrl)}for url: ${STAND_IN_URL}`;
    // Keep the phrases the adapter's classifier keys on; drop everything else.
    for (const phrase of ['Read timed out', 'Failed to establish a new connection', 'Name or service not known', 'Connection refused']) {
        if (message.includes(phrase)) return `Error refreshing EPG data: example: ${phrase}`;
    }
    return 'Error refreshing EPG data: example';
}

function scrubRow(row: Row, label: string, n: number): Row {
    const out: Row = { ...row };
    for (const key of SECRET_KEYS) if (key in out) out[key] = '';
    if ('custom_properties' in out) out.custom_properties = {};
    if (typeof out.name === 'string') out.name = `${label} ${n}`;
    if (typeof out.last_message === 'string' && out.last_message !== '') out.last_message = scrubMessage(out.last_message);
    if (Array.isArray(out.profiles)) {
        out.profiles = (out.profiles as unknown[]).map((p, i) => (isRow(p) ? scrubRow(p, 'Example Profile', i + 1) : p));
    }
    return out;
}

/** Accounts and sources share the shape; a row with `profiles` or `account_type` is an M3U account. */
export function anonymiseDispatcharr(body: unknown): unknown {
    if (!Array.isArray(body)) return body;
    return (body as unknown[]).map((row, i) => {
        if (!isRow(row)) return row;
        const label = 'profiles' in row || 'account_type' in row || 'server_url' in row ? 'Example Provider' : 'Example EPG';
        return scrubRow(row, label, i + 1);
    });
}

/** Every path in `body` that still holds a credential-bearing value; empty means safe to commit. */
export function findDispatcharrSecrets(body: unknown, path = '$'): string[] {
    if (Array.isArray(body)) return body.flatMap((v, i) => findDispatcharrSecrets(v, `${path}[${i}]`));
    if (!isRow(body)) return [];
    const found: string[] = [];
    for (const [key, value] of Object.entries(body)) {
        const at = `${path}.${key}`;
        if ((SECRET_KEYS as readonly string[]).includes(key) && value !== '' && value !== null && value !== undefined) found.push(at);
        else if (key === 'custom_properties' && isRow(value) && Object.keys(value).length > 0) found.push(at);
        else if (key === 'last_message' && typeof value === 'string' && value !== '' && /https?:\/\//.test(value) && !value.includes('provider.example')) found.push(at);
        else found.push(...findDispatcharrSecrets(value, at));
    }
    return found;
}
