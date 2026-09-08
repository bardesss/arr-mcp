import { listInstances, type ServiceInstance } from '../config/instances.ts';
import type {
    Config,
    Instanced,
    KeyedServiceConfig,
    MultiUserServiceConfig
} from '../config/schema.ts';
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
import type { ServiceAdapter } from './types.ts';

/**
 * The one place that knows which config key builds which adapter.
 *
 * `listInstances` has already flattened one-or-many into a list ordered by id,
 * so this no longer decides ordering — it only decides construction. The order
 * is still alphabetical by id, which keeps stack_health's output stable across
 * restarts and diffable in tests, and now keeps `radarr/4k` next to `radarr/hd`.
 *
 * The casts are narrowing a union the schema has already discriminated by key:
 * `services.jellyfin` cannot be a Transmission block. A `switch` cannot see
 * that, so each case restates the type its constructor needs.
 *
 * With two exceptions, and they are worth knowing about rather than tidying
 * away. `qbittorrent` and `transmission` carry no cast because they need none:
 * every `AnyServiceConfig` member structurally satisfies
 * `Instanced<CredentialServiceConfig>`, so the compiler accepts any of them
 * there. Adding a cast is rejected as unnecessary, which is the compiler
 * confirming the gap rather than closing it.
 *
 * The consequence: swapping those two case bodies would hand the wrong config
 * to the wrong constructor and still compile. Closing it properly means a
 * type-level map from service id to config type, which is a change to the
 * schema rather than to this file (#201).
 */
export function buildAdapters(config: Config): ServiceAdapter[] {
    return listInstances(config).map(buildAdapter);
}

function buildAdapter(instance: ServiceInstance): ServiceAdapter {
    const keyed = instance.config as Instanced<KeyedServiceConfig>;

    switch (instance.type) {
        case 'bazarr':
            return new BazarrAdapter(keyed);
        case 'jellyfin':
            return new JellyfinAdapter(instance.config as MultiUserServiceConfig);
        case 'prowlarr':
            return new ProwlarrAdapter(keyed);
        case 'qbittorrent':
            return new QbittorrentAdapter(instance.config);
        case 'radarr':
            return new RadarrAdapter(keyed);
        case 'sabnzbd':
            return new SabnzbdAdapter(keyed);
        case 'seerr':
            return new SeerrAdapter(instance.config as MultiUserServiceConfig);
        case 'sonarr':
            return new SonarrAdapter(keyed);
        case 'transmission':
            return new TransmissionAdapter(instance.config);
        case 'plex':
            return new PlexAdapter(instance.config as MultiUserServiceConfig);
    }
}
