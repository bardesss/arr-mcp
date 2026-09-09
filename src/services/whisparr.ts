import type { Instanced, KeyedServiceConfig, ServiceId } from '../config/schema.ts';
import { apiKeyHeader } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { ServiceHttp } from '../core/http.ts';
import { arrVersion } from './arrSystem.ts';
import { diagnoseConnection, type ConnectionDiagnosis, type ServiceAdapter } from './types.ts';
import { parseVersion } from './versions.ts';

/**
 * Whisparr V2 — a Sonarr fork on `/api/v3`, keeping Sonarr's nouns. A site is a
 * series and a scene is an episode, so the shared `arr*` helpers apply with the
 * `'series'` noun and `sizeOnDisk` nests under `statistics` exactly as Sonarr's
 * does.
 *
 * This adapter binds to those helpers the way `sonarr.ts` does rather than
 * sharing a base class with it. The sharing already exists one level down — the
 * `arr*` helpers are the shared code, and `radarr.ts` and `sonarr.ts` already
 * duplicate this binding layer rather than abstract it.
 *
 * **V2 only.** Whisparr ships as two incompatible applications that answer on
 * the same path with the same header: V2 (this one) and V3 "Eros", a Radarr
 * fork whose scenes are `/movie` entries. Eros is a separate service id, not a
 * variant probed for at runtime, so every endpoint here stays static and no
 * fixture has to be invented for a shape nobody ran.
 *
 * Single-instance for the same reason: the one deployment that would want two
 * Whisparrs is V2 beside Eros during a migration, and that is already two keys.
 */
export class WhisparrAdapter implements ServiceAdapter {
    readonly type: ServiceId = 'whisparr';
    readonly instance: string | undefined = undefined;
    readonly id: string = 'whisparr';
    readonly #http: ServiceHttp;

    constructor(config: Instanced<KeyedServiceConfig>, fetchImpl: typeof fetch = fetch) {
        this.#http = new ServiceHttp(this.id, config, apiKeyHeader('X-Api-Key', config.api_key), fetchImpl);
    }

    /**
     * Rejects Eros by name rather than letting it through.
     *
     * `assertVersionSupported` only has a floor, and Eros is 3.x — above it. So
     * an Eros instance configured here would connect cleanly and then fail on
     * the first `/series` read, which Eros does not serve. There is nothing in
     * the URL or the credential to tell the two apart, so the version is the
     * only place this can be caught, and it has to say which application it
     * found.
     */
    async getVersion(): Promise<string> {
        const raw = await arrVersion(this.#http, this.id);
        const major = parseVersion(raw)?.[0];
        if (major !== undefined && major !== 2) {
            throw new ServiceError('VersionUnsupported', this.id, `reports version ${raw}`, {
                remedy:
                    'This looks like Whisparr Eros (V3), which is a Radarr fork and a different API. ' +
                    'The `whisparr` service is Whisparr V2 only.'
            });
        }
        return raw;
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, this.type, () => this.getVersion());
    }
}
