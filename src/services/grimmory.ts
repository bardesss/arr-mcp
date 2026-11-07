import type { ConfigByService, ServiceId } from '../config/schema.ts';
import { grimmorySession, noAuth } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { fenceText } from '../core/fence.ts';
import { ServiceHttp } from '../core/http.ts';
import { compareVersions, parseVersion } from './versions.ts';
import { diagnoseConnection, type ConnectionDiagnosis, type HealthCheck, type HealthCheckCapable, type ServiceAdapter } from './types.ts';

/** The Grimmory this adapter was written against and captured on. */
export const TESTED_VERSION = '3.5.0';

const HEALTH_PATH = '/api/v1/healthcheck';
const LIBRARIES_PATH = '/api/v1/libraries';

/** Pending Bookdrop files older than this are worth a warning. */
const BOOKDROP_STALE_MS = 24 * 3_600_000;

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Raw) : {});
const list = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter((r): r is Raw => typeof r === 'object' && r !== null) : []);

/** Says which read failed and why in a word; never the URL or a response body. */
function unreadable(name: string, reason: unknown): string {
    const status = reason instanceof ServiceError ? /^HTTP (\d+)/.exec(reason.detail)?.[1] : undefined;
    if (status === '403') return `This Grimmory account may not read ${name}, so it is left out.`;
    const why = status !== undefined ? `HTTP ${status}` : reason instanceof ServiceError ? reason.kind : 'error';
    return `Grimmory's ${name} could not be read (${why}), so it is left out.`;
}

type RawHealth = { data?: { version?: unknown } };

/**
 * Grimmory's REST API, written against tag v3.5.0. It signs in with a username
 * and password and answers with a JWT; the healthcheck is the one route that
 * takes no token.
 */
export class GrimmoryAdapter implements ServiceAdapter, HealthCheckCapable {
    readonly type: ServiceId = 'grimmory';
    readonly id = 'grimmory';
    readonly #http: ServiceHttp;
    /** The same timeout and breaker, without the login: the healthcheck needs no token. */
    readonly #public: ServiceHttp;

    readonly #now: () => number;

    constructor(config: ConfigByService['grimmory'], fetchImpl: typeof fetch = fetch, opts: { now?: () => number } = {}) {
        this.#now = opts.now ?? Date.now;
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

    /**
     * Libraries whose folder cannot be reached, Bookdrop files left waiting
     * over a day, and a newer release. Each read stands alone: a 403 on the
     * Bookdrop (it needs a permission) drops that finding and nothing else.
     */
    async getFailedHealthChecks(): Promise<HealthCheck[]> {
        const check = (source: string, type: string, message: string): HealthCheck => ({ service: this.id, source, type, message });
        const [libraries, health, version, bookdrop] = await Promise.allSettled([
            this.#http.get<unknown>(LIBRARIES_PATH),
            this.#http.get<unknown>(`${LIBRARIES_PATH}/health`),
            this.#http.get<unknown>('/api/v1/version'),
            this.#bookdropFinding()
        ]);
        const out: HealthCheck[] = [];
        const left = (name: string, r: PromiseSettledResult<unknown>): void => {
            if (r.status === 'rejected') out.push(check(name, 'notice', unreadable(name, r.reason)));
        };
        left('libraries', libraries);
        left('library health', health);
        left('version', version);
        left('bookdrop', bookdrop);

        if (libraries.status === 'fulfilled' && health.status === 'fulfilled') {
            const reach = obj(health.value);
            for (const lib of list(libraries.value)) {
                if (reach[String(lib.id)] !== false) continue;
                const name = typeof lib.name === 'string' && lib.name !== '' ? lib.name : `#${String(lib.id)}`;
                out.push(check('library', 'error', `Library ${fenceText(name, { service: this.id, field: 'library_name' })} cannot be reached: its folder is missing or unreadable.`));
            }
        }
        if (bookdrop.status === 'fulfilled' && bookdrop.value !== undefined) out.push(bookdrop.value);
        if (version.status === 'fulfilled') {
            const { current, latest } = obj(version.value);
            const have = typeof current === 'string' ? parseVersion(current) : undefined;
            const newest = typeof latest === 'string' ? parseVersion(latest) : undefined;
            if (typeof current === 'string' && typeof latest === 'string' && have !== undefined && newest !== undefined && compareVersions(newest, have) > 0) {
                out.push(check('update', 'notice', `Grimmory ${latest} is out; this is ${current}.`));
            }
        }
        return out;
    }

    async #bookdropFinding(): Promise<HealthCheck | undefined> {
        const pending = Number(obj(await this.#http.get<unknown>('/api/v1/bookdrop/notification')).pendingCount);
        if (!(pending > 0)) return undefined;
        const page = obj(await this.#http.get<unknown>('/api/v1/bookdrop/files?status=pending&page=0&size=50'));
        const times = list(page.content)
            .map(f => Date.parse(String(f.createdAt)))
            .filter(t => Number.isFinite(t));
        if (times.length === 0) return undefined;
        const oldest = Math.min(...times);
        if (this.#now() - oldest <= BOOKDROP_STALE_MS) return undefined;
        const day = new Date(oldest).toISOString().slice(0, 10);
        return {
            service: this.id,
            source: 'bookdrop',
            type: 'warning',
            message: `${pending} ${pending === 1 ? 'book has' : 'books have'} been waiting in the Bookdrop since ${day}.`
        };
    }
}
