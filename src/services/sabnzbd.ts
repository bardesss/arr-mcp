import type { KeyedServiceConfig, ServiceId } from '../config/schema.ts';
import { queryParamKey } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { ServiceHttp } from '../core/http.ts';
import {
    diagnoseConnection,
    type ConnectionDiagnosis,
    type DiskSpace,
    type DiskSpaceCapable,
    type ServiceAdapter
} from './types.ts';

/**
 * Hand-written: SABnzbd's API is query-parameter driven and publishes no
 * OpenAPI document. The key travels in the URL, which is why ServiceHttp never
 * puts a full URL into an error message.
 */
type RawVersion = { version?: string };
type RawQueue = {
    queue?: {
        diskspace1?: string;
        diskspacetotal1?: string;
        diskspace2?: string;
        diskspacetotal2?: string;
        status?: string;
    };
};

const BYTES_PER_GB = 1024 ** 3;

/**
 * SABnzbd reports disk space as gigabytes in a string — confirmed against a
 * live 5.0.4, which returned `"4711.95"`. A silent NaN here would surface as
 * "0 bytes free" in stack_health, which reads as a crisis rather than a bug.
 */
const gigabytesToBytes = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed * BYTES_PER_GB) : undefined;
};

export class SabnzbdAdapter implements ServiceAdapter, DiskSpaceCapable {
    readonly id: ServiceId = 'sabnzbd';
    readonly #http: ServiceHttp;

    constructor(config: KeyedServiceConfig, fetchImpl: typeof fetch = fetch) {
        this.#http = new ServiceHttp('sabnzbd', config, queryParamKey('apikey', config.api_key), fetchImpl);
    }

    async getVersion(): Promise<string> {
        const body = await this.#http.get<RawVersion>('/api?mode=version&output=json');
        if (!body.version) {
            throw new ServiceError('UpstreamError', this.id, 'mode=version returned no version field');
        }
        return body.version;
    }

    /**
     * SABnzbd reports up to two download volumes. Both are surfaced, because a
     * stack with an incomplete and a complete directory on different disks can
     * run out of space on either.
     */
    async getDiskSpace(): Promise<DiskSpace[]> {
        const body = await this.#http.get<RawQueue>('/api?mode=queue&output=json');
        // `string | undefined` rather than optional: exactOptionalPropertyTypes
        // treats "absent" and "present but undefined" as different types, and
        // these fields are always present here, sometimes holding undefined.
        const volumes: { label: string; free: string | undefined; total: string | undefined }[] = [
            { label: 'SABnzbd download', free: body.queue?.diskspace1, total: body.queue?.diskspacetotal1 },
            { label: 'SABnzbd secondary', free: body.queue?.diskspace2, total: body.queue?.diskspacetotal2 }
        ];

        return volumes.flatMap(({ label, free, total }) => {
            const freeBytes = gigabytesToBytes(free);
            if (freeBytes === undefined) return [];
            const totalBytes = gigabytesToBytes(total);
            return [
                {
                    service: this.id,
                    path: label,
                    label,
                    freeSpace: freeBytes,
                    ...(totalBytes === undefined ? {} : { totalSpace: totalBytes })
                }
            ];
        });
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, () => this.getVersion());
    }
}
