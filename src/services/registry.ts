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
import type { ServiceAdapter } from './types.ts';

/**
 * The one place that knows which config key builds which adapter.
 *
 * `listInstances` has already flattened one-or-many into a list ordered by id,
 * so this no longer decides ordering — it only decides construction. The order
 * is still alphabetical by id, which keeps stack_health's output stable across
 * restarts and diffable in tests, and now keeps `radarr/4k` next to `radarr/hd`.
 *
 * No casts. `ServiceInstance` is discriminated on `type`, so each case
 * narrows its own config and hands it straight to the constructor. Before
 * that, every case restated its type with an unchecked `as`, and two needed
 * no cast at all: every member of `AnyServiceConfig` structurally satisfies
 * `Instanced<CredentialServiceConfig>`, so the compiler accepted anything in
 * those two and a swapped case body would have shipped (#201).
 *
 * **What this does and does not catch**, measured by swapping bodies and
 * running `tsc` rather than assumed:
 *
 * - Caught: handing a config to an adapter that needs a field it lacks.
 *   `radarr` to `JellyfinAdapter` fails (no `allow_other_users`), and
 *   `qbittorrent` to `RadarrAdapter` fails (no `api_key`).
 * - Not caught: the reverse. `MultiUserServiceConfig` is a superset of
 *   `KeyedServiceConfig`, so `jellyfin` to `RadarrAdapter` compiles, as does
 *   `radarr` to `QbittorrentAdapter` — the credential fields are optional.
 * - Not caught: swapping two services whose configs are the same type at all.
 *   `seerr` and `plex` and `jellyfin` are all `MultiUserServiceConfig`;
 *   `transmission` and `qbittorrent` are both credential blocks.
 *
 * That is structural typing, not a gap in this file. Closing it needs a
 * required brand on each entry of `ConfigByService`, minted by the one cast
 * in `listInstances` — which would also mean every adapter constructor and
 * every test that builds one by hand taking the branded type. Not worth it
 * for the residue; worth writing down so nobody reads "no casts" as "no
 * mix-ups possible".
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
    }
}
