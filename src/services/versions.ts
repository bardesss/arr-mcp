import type { ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';

/**
 * Minimum supported version per service.
 *
 * **These are judgement calls about which releases this project supports**, not
 * facts any capture can settle. They are set conservatively below the versions
 * on the stack this was developed against — Radarr 6.3.0, Sonarr 4.0.19,
 * Prowlarr 2.5.2, Bazarr 1.6.0, Jellyfin 10.11.11, Seerr 3.4.1, SABnzbd 5.0.4,
 * Transmission 4.1.3 — at the point where the API surface we use stabilised.
 *
 * Expect to argue with them. Raising one is a breaking change for somebody.
 */
export const MINIMUM_VERSIONS: Record<ServiceId, string> = {
    // v3 API and the diskspace/health/task endpoints as we read them.
    radarr: '4.0.0',
    sonarr: '4.0.0',
    // v1 API; Prowlarr never had a v3.
    prowlarr: '1.0.0',
    // `{ data: … }` envelope on /api/system/status.
    bazarr: '1.4.0',
    // /ScheduledTasks with LastExecutionResult, and Fields=ProviderIds.
    jellyfin: '10.8.0',
    // Seerr forked from Overseerr in February 2026; 1.0 is its first release.
    seerr: '1.0.0',
    // output=json on the query-parameter API.
    sabnzbd: '3.0.0',
    // RPC session handshake and download-dir-free-space.
    transmission: '3.0.0',
    // The v2 WebUI API, which 4.1.0 introduced and nothing before it has.
    qbittorrent: '4.1.0',
    // Plex has not pinned a minimum; 1.0.0 is a placeholder. The one version
    // this has actually been verified against is 1.43.3.10896 (issue #180) —
    // a single data point, not enough to raise the floor from.
    plex: '1.0.0'
};

/** Digits only; a build suffix such as Transmission's "(838877323f)" is dropped. */
export function parseVersion(raw: string): number[] | undefined {
    const match = /(\d+(?:\.\d+)*)/.exec(raw.trim().replace(/^v/i, ''));
    if (match?.[1] === undefined) return undefined;
    return match[1].split('.').map(Number);
}

/** Numeric per part — a string compare would put "10" below "9". */
export function compareVersions(a: number[], b: number[]): number {
    const length = Math.max(a.length, b.length);
    for (let i = 0; i < length; i += 1) {
        const diff = (a[i] ?? 0) - (b[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

/**
 * Connection tests distinguish version-too-old from DNS failure, connection
 * refused and a bad key. This is the only thing that produces
 * `VersionUnsupported`, which sat in the error taxonomy with nothing able to
 * reach it.
 */
export function assertVersionSupported(service: ServiceId, raw: string): void {
    const floor = MINIMUM_VERSIONS[service];
    const actual = parseVersion(raw);
    const minimum = parseVersion(floor);

    // An unparseable version is not evidence of an old one. Refusing to talk to
    // the service would be worse than the uncertainty, and its own reads will
    // fail loudly and specifically if the version really is too old.
    if (actual === undefined || minimum === undefined) return;

    if (compareVersions(actual, minimum) < 0) {
        throw new ServiceError('VersionUnsupported', service, `reports version ${raw}`, {
            remedy: `arr-mcp needs ${service} ${floor} or newer. Upgrade the service, or pin an older arr-mcp.`
        });
    }
}
