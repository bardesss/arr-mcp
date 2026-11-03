import type { ConfigByService, ServiceId } from '../config/schema.ts';
import { apiKeyHeader } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { fenceText } from '../core/fence.ts';
import { ServiceHttp } from '../core/http.ts';
import { diagnoseConnection, type ConnectionDiagnosis, type HealthCheck, type HealthCheckCapable, type ServiceAdapter } from './types.ts';
import { compareVersions, parseVersion } from './versions.ts';

export const TESTED_MINOR = '0.33';

const VERSION_PATH = '/api/core/version/';
const ACCOUNTS_PATH = '/api/m3u/accounts/';
const SOURCES_PATH = '/api/epg/sources/';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** A provider account this close to its expiry date is worth a warning. */
const EXPIRY_WARNING_DAYS = 14;
/** An account is stale once this many of its refresh intervals have passed with no successful refresh. */
const STALE_INTERVALS = 3;

const REMEDY_403 =
    'The key works but cannot read M3U accounts: give its Dispatcharr user the Standard level or higher, and check Settings â†’ Network Access allows this host for the UI/API.';
const REMEDY_401 = 'Dispatcharr rejected the API key. Create one under Users â†’ API & XC.';

type RawVersion = { version?: string };

/**
 * What arr-mcp keeps of an M3U account or EPG source. Built field by field
 * from the raw JSON, so the provider `username`, `password` (returned to
 * admins), `server_url`, `url`, `custom_properties` and profile patterns never
 * survive the parse. `last_message` is reduced to a reason here and dropped.
 */
type Profile = { name: string; active: boolean; expiresAt?: string };
type Account = { name: string; active: boolean; status: string; reason?: string; refreshedAt?: string; intervalHours: number; cron: boolean; profiles: Profile[] };
type Source = { name: string; active: boolean; status: string; reason?: string };

type Raw = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const rows = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter((r): r is Raw => typeof r === 'object' && r !== null) : []);

function accountOf(raw: Raw): Account {
    const status = str(raw.status) ?? 'unknown';
    const refreshedAt = str(raw.updated_at);
    return {
        name: str(raw.name) ?? 'unnamed',
        active: raw.is_active === true,
        status,
        ...(status === 'error' ? { reason: refreshReason(str(raw.last_message)) } : {}),
        ...(refreshedAt === undefined ? {} : { refreshedAt }),
        intervalHours: typeof raw.refresh_interval === 'number' ? raw.refresh_interval : 0,
        cron: str(raw.cron_expression) !== undefined,
        profiles: rows(raw.profiles).map(p => {
            const expiresAt = str(p.exp_date);
            return { name: str(p.name) ?? 'unnamed', active: p.is_active === true, ...(expiresAt === undefined ? {} : { expiresAt }) };
        })
    };
}

function sourceOf(raw: Raw): Source {
    const status = str(raw.status) ?? 'unknown';
    return {
        name: str(raw.name) ?? 'unnamed',
        active: raw.is_active === true,
        status,
        ...(status === 'error' ? { reason: refreshReason(str(raw.last_message)) } : {})
    };
}

const STATUS = /HTTP (\d{3})\b|\((\d{3})\)|status (\d{3})\b/;
const TIMED_OUT = /timed out|timeout|took too long/i;
const UNREACHABLE = /Failed to establish|Name or service not known|Connection refused|Max retries exceeded|Connection error|Network error|Unable to connect/i;

/**
 * Dispatcharr's fixed messages (apps/m3u/tasks.py, apps/epg/tasks.py at
 * v0.33.0), checked before the status: several also carry a number in
 * brackets, such as a profile id, that is not an HTTP status.
 */
const FIXED: [RegExp, string][] = [
    [/No M3U source available|Missing server URL/i, 'no playlist URL or file is set'],
    [/Missing username or password/i, 'the account has no username or password set'],
    [/empty M3U file|No streams found|No streams returned|completely empty response|missing or empty/i, 'the provider sent an empty playlist'],
    [/HTML page instead|invalid M3U content|non-text content|error message instead of M3U/i, 'the provider sent something that is not a playlist'],
    [/EPG file appears incomplete|Error parsing XML/i, 'the guide file was incomplete or malformed'],
    [/rate limited/i, 'the provider is rate limiting requests (HTTP 429)'],
    [/Failed to authenticate|Authentication failed for profile/i, 'the provider refused the login']
];

/**
 * Why a refresh failed, in a fixed vocabulary. Dispatcharr writes the
 * provider URL (credentials in its query string) and the provider's own
 * reply into `last_message`, so nothing from the input is ever copied out
 * except a three-digit status.
 */
export function refreshReason(message: string | null | undefined): string {
    if (!message) return 'refresh failed';
    for (const [pattern, reason] of FIXED) if (pattern.test(message)) return reason;
    const match = STATUS.exec(message);
    const status = match === null ? undefined : Number(match[1] ?? match[2] ?? match[3]);
    if (status !== undefined) {
        if (status === 401 || status === 884) return `the provider refused the login (HTTP ${status})`;
        if (status === 403) return 'the provider refused access (HTTP 403)';
        if (status === 404) return 'the provider has no playlist at that URL (HTTP 404)';
        if (status === 500) return 'the provider failed (HTTP 500)';
        return `the provider answered HTTP ${status}`;
    }
    if (TIMED_OUT.test(message)) return 'the request timed out';
    if (UNREACHABLE.test(message)) return 'could not reach the provider';
    return 'refresh failed';
}

/**
 * Dispatcharr's REST API, written against tag v0.33.0. Read only, and it
 * never keeps a provider credential: see the allowlist below.
 */
export class DispatcharrAdapter implements ServiceAdapter, HealthCheckCapable {
    readonly type: ServiceId = 'dispatcharr';
    readonly id = 'dispatcharr';
    readonly #http: ServiceHttp;

    constructor(config: ConfigByService['dispatcharr'], fetchImpl: typeof fetch = fetch) {
        this.#http = new ServiceHttp(this.id, config, apiKeyHeader('X-API-Key', config.api_key), fetchImpl);
    }

    async getVersion(): Promise<string> {
        const body = await this.#http.get<RawVersion>(VERSION_PATH);
        if (!body.version) throw new ServiceError('UpstreamError', this.id, 'version returned no version field');
        return body.version;
    }

    /** The version route is AllowAny, so it alone would pass a key that can read nothing. */
    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, this.type, async () => {
            const version = await this.getVersion();
            try {
                await this.#http.get<unknown>(ACCOUNTS_PATH);
            } catch (err) {
                if (err instanceof ServiceError && err.kind === 'AuthFailed') {
                    if (err.detail.includes('HTTP 403')) throw new ServiceError('AuthFailed', this.id, err.detail, { remedy: REMEDY_403 });
                    if (err.detail.includes('HTTP 401')) throw new ServiceError('AuthFailed', this.id, err.detail, { remedy: REMEDY_401 });
                }
                throw err;
            }
            return version;
        });
    }

    async getFailedHealthChecks(): Promise<HealthCheck[]> {
        const [version, accounts, sources] = await Promise.all([this.getVersion(), this.#accounts(), this.#sources()]);
        const check = (source: string, type: string, message: string): HealthCheck => ({ service: this.id, source, type, message });
        const name = (value: string) => fenceText(value, { service: this.id, field: 'name' });
        const now = Date.now();
        const out: HealthCheck[] = [];

        for (const a of accounts.filter(a => a.active)) {
            if (a.status === 'error') out.push(check('m3u', 'error', `M3U account ${name(a.name)} failed to refresh: ${a.reason ?? 'refresh failed'}`));
            if (a.status === 'pending_setup') out.push(check('m3u', 'warning', `M3U account ${name(a.name)} is still pending setup`));
            const refreshed = a.refreshedAt === undefined ? NaN : Date.parse(a.refreshedAt);
            if (!a.cron && a.intervalHours > 0 && now - refreshed > STALE_INTERVALS * a.intervalHours * HOUR_MS) {
                out.push(check('m3u', 'warning', `M3U account ${name(a.name)} has not refreshed since ${a.refreshedAt}; it is set to refresh every ${a.intervalHours}h`));
            }
            for (const p of a.profiles.filter(p => p.active && p.expiresAt !== undefined)) {
                const at = Date.parse(p.expiresAt as string);
                if (Number.isNaN(at)) continue;
                const day = new Date(at).toISOString().slice(0, 10);
                const label = `Provider account ${name(a.name)} / ${name(p.name)}`;
                if (at <= now) out.push(check('m3u', 'error', `${label} expired on ${day}`));
                else if (at - now <= EXPIRY_WARNING_DAYS * DAY_MS) out.push(check('m3u', 'warning', `${label} expires on ${day}`));
            }
        }

        for (const s of sources.filter(s => s.active && s.status === 'error')) {
            out.push(check('epg', 'error', `EPG source ${name(s.name)} failed to refresh: ${s.reason ?? 'refresh failed'}`));
        }

        const actual = parseVersion(version);
        const tested = parseVersion(TESTED_MINOR);
        if (actual !== undefined && tested !== undefined && compareVersions(actual.slice(0, 2), tested) > 0) {
            out.push(check('version', 'warning', `Dispatcharr ${version} is newer than ${TESTED_MINOR}.x, which this adapter was written against; untested, results may be wrong`));
        }
        return out;
    }

    async #accounts(): Promise<Account[]> {
        return rows(await this.#http.get<unknown>(ACCOUNTS_PATH)).map(accountOf);
    }

    async #sources(): Promise<Source[]> {
        return rows(await this.#http.get<unknown>(SOURCES_PATH)).map(sourceOf);
    }
}