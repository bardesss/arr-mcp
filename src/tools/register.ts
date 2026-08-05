import type { McpServer } from '@modelcontextprotocol/server';
import type { Config } from '../config/schema.ts';
import { IdentityResolver } from '../core/identity.ts';
import { JellyfinAdapter } from '../services/jellyfin.ts';
import { SeerrAdapter } from '../services/seerr.ts';
import { hasIndexers, hasSubtitles, type ServiceAdapter } from '../services/types.ts';
import { registerDiagnose } from './diagnose/index.ts';
import { registerDiscoverMedia } from './discoverMedia.ts';
import { registerGetCalendar } from './getCalendar.ts';
import { registerGetIndexers } from './getIndexers.ts';
import { registerGetLibrary } from './getLibrary.ts';
import { registerGetMediaDetails } from './getMediaDetails.ts';
import { registerGetPlayback } from './getPlayback.ts';
import { registerGetQueue } from './getQueue.ts';
import { registerGetRequests } from './getRequests.ts';
import { registerGetSubtitles } from './getSubtitles.ts';
import { LibraryLoader } from './library.ts';
import { registerLookupMedia } from './lookupMedia.ts';
import { registerSearchMedia } from './searchMedia.ts';
import { registerStackHealth } from './stackHealth.ts';

/**
 * Identity resolvers built once, here, rather than inside the per-request
 * server factory: they cache the service's user directory, and rebuilding them
 * per request would refetch it on every tool call.
 */
export type ToolContext = {
    adapters: readonly ServiceAdapter[];
    jellyfinIdentity: IdentityResolver | undefined;
    seerrIdentity: IdentityResolver | undefined;
    library: LibraryLoader;
};

export function buildToolContext(adapters: readonly ServiceAdapter[], config: Config): ToolContext {
    const jellyfin = adapters.find((a): a is JellyfinAdapter => a instanceof JellyfinAdapter);
    const seerr = adapters.find((a): a is SeerrAdapter => a instanceof SeerrAdapter);

    const jellyfinIdentity =
        jellyfin !== undefined && config.services.jellyfin !== undefined
            ? new IdentityResolver(jellyfin, config.services.jellyfin)
            : undefined;

    return {
        adapters,
        jellyfinIdentity,
        seerrIdentity:
            seerr !== undefined && config.services.seerr !== undefined
                ? new IdentityResolver(seerr, config.services.seerr)
                : undefined,
        library: new LibraryLoader(adapters, jellyfinIdentity)
    };
}

/**
 * One registration point.
 *
 * Tools whose service is not configured are **still registered**: they return
 * an empty result explaining the service is absent. Hiding a tool would make
 * the surface depend on configuration, and design spec §18 treats the tool
 * surface as the public API — a model that learned `get_subtitles` exists must
 * not find it missing after a config edit.
 */
export function registerAllTools(server: McpServer, context: ToolContext): void {
    const { adapters, jellyfinIdentity, seerrIdentity, library } = context;
    const jellyfin = adapters.find((a): a is JellyfinAdapter => a instanceof JellyfinAdapter);
    const seerr = adapters.find((a): a is SeerrAdapter => a instanceof SeerrAdapter);

    registerDiagnose(server, { adapters, library });
    registerStackHealth(server, adapters);
    registerGetIndexers(server, adapters.find(hasIndexers));
    registerGetSubtitles(server, adapters.find(hasSubtitles));
    registerGetQueue(server, adapters);
    registerGetCalendar(server, adapters);
    registerGetPlayback(server, jellyfin, jellyfinIdentity);
    registerGetRequests(server, seerr, seerrIdentity);
    registerGetMediaDetails(server, adapters, library);
    registerGetLibrary(server, library);
    registerSearchMedia(server, adapters);
    registerLookupMedia(server, adapters);
    registerDiscoverMedia(server, seerr);
}

/** The tool surface, frozen. §18: renaming one breaks users' saved prompts. */
export const TOOL_NAMES = [
    'diagnose',
    'stack_health',
    'get_indexers',
    'get_subtitles',
    'get_queue',
    'get_calendar',
    'get_playback',
    'get_requests',
    'get_media_details',
    'get_library',
    'search_media',
    'lookup_media',
    'discover_media'
] as const;
