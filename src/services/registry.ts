import { listInstances, type ServiceInstance } from '../config/instances.ts';
import type {
    Config,
    KeyedServiceConfig,
    MultiUserServiceConfig,
    TransmissionServiceConfig
} from '../config/schema.ts';
import { BazarrAdapter } from './bazarr.ts';
import { JellyfinAdapter } from './jellyfin.ts';
import { ProwlarrAdapter } from './prowlarr.ts';
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
 */
export function buildAdapters(config: Config): ServiceAdapter[] {
    return listInstances(config).map(buildAdapter);
}

function buildAdapter(instance: ServiceInstance): ServiceAdapter {
    const keyed = instance.config as KeyedServiceConfig;

    switch (instance.type) {
        case 'bazarr':
            return new BazarrAdapter(keyed);
        case 'jellyfin':
            return new JellyfinAdapter(instance.config as MultiUserServiceConfig);
        case 'prowlarr':
            return new ProwlarrAdapter(keyed);
        case 'radarr':
            return new RadarrAdapter(keyed);
        case 'sabnzbd':
            return new SabnzbdAdapter(keyed);
        case 'seerr':
            return new SeerrAdapter(instance.config as MultiUserServiceConfig);
        case 'sonarr':
            return new SonarrAdapter(keyed);
        case 'transmission':
            return new TransmissionAdapter(instance.config as TransmissionServiceConfig);
    }
}
