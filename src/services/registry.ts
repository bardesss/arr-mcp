import type { Config } from '../config/schema.ts';
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
 * Alphabetical order makes stack_health's output stable across restarts and
 * diffable in tests, which matters more than any other ordering would.
 */
export function buildAdapters(config: Config): ServiceAdapter[] {
    const s = config.services;
    const adapters: ServiceAdapter[] = [];

    if (s.bazarr) adapters.push(new BazarrAdapter(s.bazarr));
    if (s.jellyfin) adapters.push(new JellyfinAdapter(s.jellyfin));
    if (s.prowlarr) adapters.push(new ProwlarrAdapter(s.prowlarr));
    if (s.radarr) adapters.push(new RadarrAdapter(s.radarr));
    if (s.sabnzbd) adapters.push(new SabnzbdAdapter(s.sabnzbd));
    if (s.seerr) adapters.push(new SeerrAdapter(s.seerr));
    if (s.sonarr) adapters.push(new SonarrAdapter(s.sonarr));
    if (s.transmission) adapters.push(new TransmissionAdapter(s.transmission));

    return adapters;
}
