import type { MultiUserServiceConfig, ServiceId } from '../config/schema.ts';
import { apiKeyHeader } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { ServiceHttp } from '../core/http.ts';
import { fenceText } from '../core/fence.ts';
import {
    diagnoseConnection,
    type ConnectionDiagnosis,
    type MediaRequest,
    type RequestStatus,
    type ServiceAdapter,
    type ServiceUser,
    type UserDirectoryCapable
} from './types.ts';

type RawStatus = { version?: string; commitTag?: string };
type RawRequest = {
    id?: number;
    status?: number;
    createdAt?: string;
    media?: { tmdbId?: number; mediaType?: string; title?: string };
    requestedBy?: { id?: number; displayName?: string; username?: string; email?: string };
};
type RawRequestPage = { results?: RawRequest[] };

/** Seerr's numeric request statuses. */
const STATUS: Record<number, RequestStatus> = { 1: 'pending', 2: 'approved', 3: 'declined' };

/**
 * Whether Seerr filters requests by user server-side — design spec §21.4.
 * When false the adapter filters in memory, which the spec sanctions at
 * household request volumes.
 */
const SEERR_FILTERS_SERVER_SIDE = false;

/** Narrowed through a typed helper: an inline ternary widens this to `string`. */
const mediaTypeOf = (value: string | undefined): MediaRequest['mediaType'] =>
    value === 'movie' || value === 'tv' ? value : 'unknown';
type RawUser = { id?: number; displayName?: string; username?: string; email?: string };
type RawUserPage = { results?: RawUser[] };

/**
 * Seerr users may have no display name. The email local part is the fallback
 * its own UI shows, so matching that avoids presenting a name the user has
 * never seen anywhere else.
 */
const nameOf = (u: RawUser): string | undefined => u.displayName ?? u.username ?? u.email?.split('@')[0];

export class SeerrAdapter implements ServiceAdapter, UserDirectoryCapable {
    readonly id: ServiceId = 'seerr';
    readonly #http: ServiceHttp;

    constructor(config: MultiUserServiceConfig, fetchImpl: typeof fetch = fetch) {
        this.#http = new ServiceHttp('seerr', config, apiKeyHeader('X-Api-Key', config.api_key), fetchImpl);
    }

    async getVersion(): Promise<string> {
        const status = await this.#http.get<RawStatus>('/api/v1/status');
        if (!status.version) {
            throw new ServiceError('UpstreamError', this.id, 'status returned no version field');
        }
        return status.version;
    }

    async listUsers(): Promise<ServiceUser[]> {
        const page = await this.#http.get<RawUserPage>('/api/v1/user');
        return (page.results ?? [])
            .map(u => ({ id: u.id, name: nameOf(u) }))
            .filter((u): u is { id: number; name: string } => u.id !== undefined && u.name !== undefined)
            .map(u => ({ id: String(u.id), name: u.name }));
    }

    async getRequests(opts: { user?: ServiceUser; status?: RequestStatus }): Promise<MediaRequest[]> {
        const params = new URLSearchParams({ take: '500' });
        if (SEERR_FILTERS_SERVER_SIDE && opts.user !== undefined) params.set('requestedBy', opts.user.id);

        const page = await this.#http.get<RawRequestPage>(`/api/v1/request?${params.toString()}`);

        return (page.results ?? [])
            .filter((r): r is RawRequest & { id: number } => typeof r.id === 'number')
            .map(r => ({
                service: this.id,
                id: r.id,
                status: STATUS[r.status ?? -1] ?? ('unknown' as const),
                mediaType: mediaTypeOf(r.media?.mediaType),
                ...(r.media?.tmdbId === undefined ? {} : { tmdbId: r.media.tmdbId }),
                ...(r.media?.title === undefined
                    ? {}
                    : { title: fenceText(r.media.title, { service: this.id, field: 'title' }) }),
                requestedBy: nameOf(r.requestedBy ?? {}) ?? 'unknown',
                ...(r.createdAt === undefined ? {} : { requestedAt: r.createdAt })
            }))
            // The in-memory user filter runs unconditionally, even when the
            // server filtered too. It costs nothing, and it means flipping
            // SEERR_FILTERS_SERVER_SIDE can never silently widen what a user sees.
            .filter(r => opts.user === undefined || r.requestedBy.toLowerCase() === opts.user.name.toLowerCase())
            .filter(r => opts.status === undefined || r.status === opts.status);
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, () => this.getVersion());
    }
}
