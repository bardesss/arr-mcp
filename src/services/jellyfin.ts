import type { MultiUserServiceConfig, ServiceId } from '../config/schema.ts';
import { embyToken } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { ServiceHttp } from '../core/http.ts';
import {
    diagnoseConnection,
    type ConnectionDiagnosis,
    type ScanState,
    type ScanStateCapable,
    type ServiceAdapter,
    type ServiceUser,
    type UserDirectoryCapable
} from './types.ts';

/**
 * Jellyfin's generated types are a megabyte of declarations and its PascalCase
 * field names are stable across releases, so these three narrow shapes are
 * declared locally. The contract test checks them against the vendored spec,
 * which is where that checking belongs.
 */
type RawSystemInfo = { Version?: string; ServerName?: string; Id?: string };
type RawUser = { Id?: string; Name?: string };
type RawTask = {
    Key?: string;
    Name?: string;
    State?: string;
    LastExecutionResult?: { EndTimeUtc?: string; Status?: string };
};

/**
 * The task Jellyfin runs to scan libraries, confirmed against a live 10.11.11.
 *
 * Keyed on `Key`, never on `Name`, for two independent reasons. A live server
 * exposes eight library-ish keys including `LanguageTagsSetsRefreshLibraryTask`
 * and `TraktSyncLibraryTask`, so a pattern would match the wrong one — and
 * `Name` is **localised to the server language**. The instance this was
 * captured from returns "Mediabibliotheek scannen".
 */
const LIBRARY_SCAN_KEY = 'RefreshLibrary';

export class JellyfinAdapter implements ServiceAdapter, ScanStateCapable, UserDirectoryCapable {
    readonly id: ServiceId = 'jellyfin';
    readonly #http: ServiceHttp;

    constructor(config: MultiUserServiceConfig, fetchImpl: typeof fetch = fetch) {
        this.#http = new ServiceHttp('jellyfin', config, embyToken(config.api_key), fetchImpl);
    }

    async getVersion(): Promise<string> {
        const info = await this.#http.get<RawSystemInfo>('/System/Info');
        if (!info.Version) {
            throw new ServiceError('UpstreamError', this.id, 'System/Info returned no version field');
        }
        return info.Version;
    }

    /**
     * Jellyfin identifies users by GUID while config names them by username, so
     * every per-user call resolves through this list. Typing a username by hand
     * is a guaranteed source of silent mismatches (design spec §14), which is
     * why the resolver reports the available names on a miss.
     */
    async listUsers(): Promise<ServiceUser[]> {
        const users = await this.#http.get<RawUser[]>('/Users');
        return users
            .filter((u): u is { Id: string; Name: string } => typeof u.Id === 'string' && typeof u.Name === 'string')
            .map(u => ({ id: u.Id, name: u.Name }));
    }

    async getScanState(): Promise<ScanState> {
        const tasks = await this.#http.get<RawTask[]>('/ScheduledTasks');
        const scan = tasks.find(t => t.Key === LIBRARY_SCAN_KEY);
        const lastCompleted = scan?.LastExecutionResult?.EndTimeUtc;
        return {
            service: this.id,
            running: scan?.State === 'Running',
            ...(typeof lastCompleted === 'string' ? { lastCompleted } : {})
        };
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, () => this.getVersion());
    }
}
