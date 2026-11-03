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
        if (message.includes(phrase)) return `Example message: ${phrase}`;
    }
    return 'Example message';
}

/** Large, never read by the adapter, and partly user-written (filter regexes). */
const DROPPED_KEYS = ['channel_groups', 'filters'];

/** Blanks secrets and empties `custom_properties` at every depth, so a nested copy cannot slip through. */
function scrubDeep(value: unknown): unknown {
    if (Array.isArray(value)) return (value as unknown[]).map(scrubDeep);
    if (!isRow(value)) return value;
    const out: Row = {};
    for (const [key, v] of Object.entries(value)) {
        if (DROPPED_KEYS.includes(key)) continue;
        if ((SECRET_KEYS as readonly string[]).includes(key)) out[key] = '';
        else if (key === 'custom_properties') out[key] = {};
        else if (key === 'last_message' && typeof v === 'string' && v !== '') out[key] = scrubMessage(v);
        else out[key] = scrubDeep(v);
    }
    return out;
}

const rowsOf = (value: unknown): Row[] => (Array.isArray(value) ? (value as unknown[]).filter(isRow) : []);

/**
 * An M3U account names its provider three times (the account, each profile's
 * `account`, and `all_expirations`), so the stand-ins are assigned once and
 * reused: profile names map by profile id.
 */
function renameAccount(row: Row, n: number): Row {
    const provider = `Example Provider ${n}`;
    const profileNames = new Map<unknown, string>();
    const profiles = rowsOf(row.profiles).map((p, i) => {
        const name = `Example Profile ${i + 1}`;
        profileNames.set(p.id, name);
        return { ...p, name, ...(isRow(p.account) ? { account: { ...p.account, name: provider } } : {}) };
    });
    return {
        ...row,
        name: provider,
        ...('profiles' in row ? { profiles } : {}),
        ...('all_expirations' in row
            ? { all_expirations: rowsOf(row.all_expirations).map((e, i) => ({ ...e, profile_name: profileNames.get(e.profile_id) ?? `Example Profile ${i + 1}` })) }
            : {})
    };
}

/** Accounts and sources share the shape; a row with `profiles`, `account_type` or `server_url` is an M3U account. */
export function anonymiseDispatcharr(body: unknown): unknown {
    if (!Array.isArray(body)) return body;
    return (body as unknown[]).map((raw, i) => {
        if (!isRow(raw)) return raw;
        const row = scrubDeep(raw) as Row;
        const isAccount = 'profiles' in raw || 'account_type' in raw || 'server_url' in raw;
        return isAccount ? renameAccount(row, i + 1) : { ...row, ...(typeof row.name === 'string' ? { name: `Example EPG ${i + 1}` } : {}) };
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
