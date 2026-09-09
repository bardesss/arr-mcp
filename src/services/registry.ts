import { listInstances, type ServiceInstance } from '../config/instances.ts';
import type { Config } from '../config/schema.ts';
import { BazarrAdapter } from './bazarr.ts';
import { JellyfinAdapter } from './jellyfin.ts';
import { PlexAdapter } from './plex.ts';
import { ProwlarrAdapter } from './prowlarr.ts';
import { QbittorrentAdapter } from './qbittorrent.ts';
import { RadarrAdapter } from './radarr.ts';
import { SabnzbdAdapter } from './sabnzbd.ts';
import { SeerrAdapter } from './seerr.ts';
import { SonarrAdapter } from './sonarr.ts';
import { TransmissionAdapter } from './transmission.ts';
import { WhisparrAdapter } from './whisparr.ts';
import type { ServiceAdapter } from './types.ts';

/**
 * The one place that knows which config key builds which adapter.
 *
 * `listInstances` has already flattened one-or-many into a list ordered by id,
 * so this no longer decides ordering — it only decides construction. The order
 * is still alphabetical by id, which keeps stack_health's output stable across
 * restarts and diffable in tests, and now keeps `radarr/4k` next to `radarr/hd`.
 *
 * No casts, and no swap that compiles. `ServiceInstance` is discriminated on
 * `type`, so each case narrows its own config, and every entry of
 * `ConfigByService` carries a phantom `__service` naming the service it
 * belongs to — so a config for one service is not assignable to an adapter
 * for another even when the two shapes are identical.
 *
 * Before this, every case restated its type with an unchecked `as`, and two
 * needed no cast at all: every member of `AnyServiceConfig` structurally
 * satisfies `Instanced<CredentialServiceConfig>`, so the compiler accepted
 * anything there and a swapped case body would have shipped (#201).
 *
 * Verified by swapping bodies and running `tsc` rather than assumed, because
 * the first attempt at this narrowed on `type` alone and left half the swaps
 * compiling — `MultiUserServiceConfig` is a superset of `KeyedServiceConfig`,
 * so a Jellyfin block satisfied a Radarr adapter, and two services sharing a
 * config shape were not separable at all. All seven swaps now fail to
 * compile, including `seerr` for `plex` and `transmission` for `qbittorrent`.
 */
export function buildAdapters(config: Config): ServiceAdapter[] {
    return listInstances(config).map(buildAdapter);
}

function buildAdapter(instance: ServiceInstance): ServiceAdapter {
    switch (instance.type) {
        case 'bazarr':
            return new BazarrAdapter(instance.config);
        case 'jellyfin':
            return new JellyfinAdapter(instance.config);
        case 'prowlarr':
            return new ProwlarrAdapter(instance.config);
        case 'qbittorrent':
            return new QbittorrentAdapter(instance.config);
        case 'radarr':
            return new RadarrAdapter(instance.config);
        case 'sabnzbd':
            return new SabnzbdAdapter(instance.config);
        case 'seerr':
            return new SeerrAdapter(instance.config);
        case 'sonarr':
            return new SonarrAdapter(instance.config);
        case 'transmission':
            return new TransmissionAdapter(instance.config);
        case 'plex':
            return new PlexAdapter(instance.config);
        case 'whisparr':
            return new WhisparrAdapter(instance.config);
    }
}
