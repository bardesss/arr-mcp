import type { ConfigByService, ServiceId } from '../config/schema.ts';
import { apiKeyHeader } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { ServiceHttp } from '../core/http.ts';
import { diagnoseConnection, type ConnectionDiagnosis, type ServiceAdapter } from './types.ts';

export const TESTED_MINOR = '0.33';

const VERSION_PATH = '/api/core/version/';
const ACCOUNTS_PATH = '/api/m3u/accounts/';

const REMEDY_403 =
    'The key works but cannot read M3U accounts: give its Dispatcharr user the Standard level or higher, and check Settings → Network Access allows this host for the UI/API.';
const REMEDY_401 = 'Dispatcharr rejected the API key. Create one under Users → API & XC.';

type RawVersion = { version?: string };

const STATUS = /HTTP (\d{3})\b|\((\d{3})\)|status (\d{3})\b/;
const TIMED_OUT = /timed out|timeout/i;
const UNREACHABLE = /Failed to establish|Name or service not known|Connection refused|Max retries exceeded/i;

/**
 * Why a refresh failed, in a fixed vocabulary. Dispatcharr writes the
 * provider URL (credentials in its query string) and the provider's own
 * reply into `last_message`, so nothing from the input is ever copied out
 * except a three-digit status.
 */
export function refreshReason(message: string | null | undefined): string {
    if (!message) return 'refresh failed';
    if (/empty M3U file/i.test(message)) return 'the provider sent an empty playlist';
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
export class DispatcharrAdapter implements ServiceAdapter {
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
}
