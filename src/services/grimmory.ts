import type { ConfigByService, ServiceId } from '../config/schema.ts';
import { grimmorySession, noAuth } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { ServiceHttp } from '../core/http.ts';
import { diagnoseConnection, type ConnectionDiagnosis, type ServiceAdapter } from './types.ts';

/** The Grimmory this adapter was written against and captured on. */
export const TESTED_VERSION = '3.5.0';

const HEALTH_PATH = '/api/v1/healthcheck';
const LIBRARIES_PATH = '/api/v1/libraries';

type RawHealth = { data?: { version?: unknown } };

/**
 * Grimmory's REST API, written against tag v3.5.0. It signs in with a username
 * and password and answers with a JWT; the healthcheck is the one route that
 * takes no token.
 */
export class GrimmoryAdapter implements ServiceAdapter {
    readonly type: ServiceId = 'grimmory';
    readonly id = 'grimmory';
    readonly #http: ServiceHttp;
    /** The same timeout and breaker, without the login: the healthcheck needs no token. */
    readonly #public: ServiceHttp;

    constructor(config: ConfigByService['grimmory'], fetchImpl: typeof fetch = fetch) {
        this.#http = new ServiceHttp(
            this.id,
            config,
            grimmorySession({ id: this.id, url: config.url, username: config.username, password: config.password, timeoutMs: config.timeout_ms, fetchImpl }),
            fetchImpl
        );
        this.#public = new ServiceHttp(this.id, config, noAuth, fetchImpl);
    }

    async getVersion(): Promise<string> {
        const body = await this.#public.get<RawHealth>(HEALTH_PATH);
        const version = body.data?.version;
        if (typeof version !== 'string' || version === '') throw new ServiceError('UpstreamError', this.id, 'healthcheck returned no version');
        return version.replace(/^v/i, '');
    }

    /** The healthcheck needs no login, so it alone would pass a wrong password. */
    async testConnection(): Promise<ConnectionDiagnosis> {
        let version: string | undefined;
        const diagnosis = await diagnoseConnection(this.id, this.type, async () => {
            version = await this.getVersion();
            await this.#http.get<unknown>(LIBRARIES_PATH);
            return version;
        });
        // A refused login still tells which Grimmory answered.
        return !diagnosis.ok && version !== undefined ? { ...diagnosis, version } : diagnosis;
    }
}
