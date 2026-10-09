import type { Config, MultiUserServiceConfig, ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import { IdentityResolver } from '../core/identity.ts';
import {
    hasPlayback,
    hasUserDirectory,
    hasUserLibrary,
    type MediaServerAdapter,
    type ServiceAdapter
} from '../services/types.ts';

export type MediaServerChoice = { adapter: MediaServerAdapter; identity: IdentityResolver | undefined };
/** `primary` is what every tool defaults to. */
export type MediaServers = { primary?: MediaServerChoice; secondary?: MediaServerChoice };

/**
 * Each candidate must be a complete media server, named when it is not: a
 * missing capability should fail at startup by name, not later with a raw
 * "listUsers is not a function" or a disagreement between tools.
 */
function complete(candidate: ServiceAdapter): MediaServerAdapter {
    if (!hasPlayback(candidate)) {
        throw new Error(
            `${candidate.id} has a user library but is missing getPlayback/getNextUp/getWatchHistory, so it is not a complete media server`
        );
    }
    if (!hasUserDirectory(candidate)) {
        throw new Error(`${candidate.id} has playback but is missing listUsers, so it is not a complete media server`);
    }
    if (!hasUserLibrary(candidate)) {
        throw new Error(`${candidate.id} has playback but is missing listUserLibrary, so it is not a complete media server`);
    }
    return candidate;
}

/** Keyed by adapter `type`; narrowed by hand because each `services` key has its own shape. */
function configFor(type: ServiceId, services: Config['services']): MultiUserServiceConfig | undefined {
    if (type === 'jellyfin') return services.jellyfin;
    if (type === 'plex') return services.plex;
    return undefined;
}

function choice(adapter: MediaServerAdapter, config: Config): MediaServerChoice {
    const block = configFor(adapter.type, config.services);
    return { adapter, identity: block === undefined ? undefined : new IdentityResolver(adapter, block) };
}

export function selectMediaServers(adapters: readonly ServiceAdapter[], config: Config): MediaServers {
    const found = adapters.filter(a => hasPlayback(a) || hasUserLibrary(a)).map(complete);
    if (found.length === 0) return {};
    if (found.length === 1) return { primary: choice(found[0] as MediaServerAdapter, config) };
    if (found.length > 2) throw new Error(`at most two media servers, found ${found.map(a => a.id).join(', ')}`);

    const wanted = config.primary_media_server;
    const primary = found.find(a => a.type === wanted);
    const secondary = found.find(a => a !== primary);
    if (primary === undefined || secondary === undefined) {
        throw new Error(
            `two media servers are configured (${found.map(a => a.id).join(', ')}) but primary_media_server does not name one`
        );
    }
    return { primary: choice(primary, config), secondary: choice(secondary, config) };
}

/** `service` undefined means the primary. Named but not configured is a NotFound with a remedy. */
export function pickMediaServer(servers: MediaServers, service: string | undefined): MediaServerChoice | undefined {
    if (service === undefined) return servers.primary;
    const hit = [servers.primary, servers.secondary].find(c => c?.adapter.id === service);
    if (hit === undefined) {
        const configured = [servers.primary, servers.secondary].flatMap(c => (c === undefined ? [] : [c.adapter.id]));
        throw new ServiceError('NotFound', service, `${service} is not configured`, {
            remedy: `Configured media servers: ${configured.join(', ') || 'none'}.`
        });
    }
    return hit;
}

/** Order-preserving (primary first) ids when both are configured, else undefined. */
export function bothIds(servers: MediaServers): [string, string] | undefined {
    return servers.primary !== undefined && servers.secondary !== undefined
        ? [servers.primary.adapter.id, servers.secondary.adapter.id]
        : undefined;
}
