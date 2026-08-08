import { listInstances } from '../config/instances.ts';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Config } from '../config/schema.ts';
import type { WriteAudit } from '../core/audit.ts';
import type { ImdbDataset } from '../metadata/imdbDataset.ts';
import type { ConfirmTokens } from '../core/confirm.ts';
import { IdentityResolver } from '../core/identity.ts';
import type { ServiceInstance } from '../config/instances.ts';
import { permissionSourceFrom } from '../core/permissions.ts';
import { JellyfinAdapter } from '../services/jellyfin.ts';
import { SeerrAdapter } from '../services/seerr.ts';
import { hasIndexers, hasSubtitles, type ServiceAdapter } from '../services/types.ts';
import { registerAddMedia } from './addMedia.ts';
import { registerDeleteMedia } from './deleteMedia.ts';
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
import { registerDeleteRequest, registerRespondToRequest } from './manageRequests.ts';
import { registerRemoveQueueItem } from './removeQueueItem.ts';
import { registerSearchMedia } from './searchMedia.ts';
import { registerStackHealth } from './stackHealth.ts';
import { registerTriggerScan } from './triggerScan.ts';
import { registerTriggerSearch } from './triggerSearch.ts';
import type { WriteContext } from './write.ts';

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
    /**
     * The IMDb dataset, when configured.
     *
     * `library` already closes over it — the owned-library join happens there
     * exactly once. This field is for the tools that answer about things you
     * may *not* own, which never touch the library index: search, lookup and
     * details. Spec §4.1 calls that the path that matters most, because a
     * rating is usually wanted before deciding to add something.
     */
    dataset: ImdbDataset | undefined;
    /** Every configured instance, as the config declares it — the source the
     *  write gate reads, so `stack_health` cannot report a different answer. */
    instances: readonly ServiceInstance[];
    /**
     * The write half (§10). Built once alongside the resolvers rather than per
     * request: `ConfirmTokens` holds the signing key and the spent-token set,
     * and rebuilding it per request would make every confirmation token invalid
     * the moment it was issued — the handshake spans two calls by construction.
     */
    write: WriteContext;
};

/**
 * `confirm` is supplied rather than created here: it outlives a config reload
 * on purpose (see `core/runtime.ts`), because a confirmation handshake spans
 * two calls and a config edit between them must not silently invalidate it.
 */
export function buildToolContext(
    adapters: readonly ServiceAdapter[],
    config: Config,
    audit: WriteAudit,
    confirm: ConfirmTokens,
    /** The IMDb dataset, when configured. Reaches the tools only through the
     *  library loader, which is the one place the join happens. */
    dataset?: ImdbDataset | undefined
): ToolContext {
    const jellyfin = adapters.find((a): a is JellyfinAdapter => a instanceof JellyfinAdapter);
    const seerr = adapters.find((a): a is SeerrAdapter => a instanceof SeerrAdapter);

    const jellyfinIdentity =
        jellyfin !== undefined && config.services.jellyfin !== undefined
            ? new IdentityResolver(jellyfin, config.services.jellyfin)
            : undefined;

    const library = new LibraryLoader(adapters, jellyfinIdentity, undefined, dataset);

    return {
        adapters,
        dataset,
        instances: listInstances(config),
        jellyfinIdentity,
        seerrIdentity:
            seerr !== undefined && config.services.seerr !== undefined
                ? new IdentityResolver(seerr, config.services.seerr)
                : undefined,
        library,
        write: {
            // From `config.services` directly, not from the adapters: the gate
            // must answer from the file, so an adapter cannot widen its own
            // permissions by reporting a capability it was never granted.
            permissions: permissionSourceFrom(listInstances(config)),
            confirm,
            audit,
            library
        }
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
    const { adapters, dataset, instances, jellyfinIdentity, seerrIdentity, library, write } = context;
    const jellyfin = adapters.find((a): a is JellyfinAdapter => a instanceof JellyfinAdapter);
    const seerr = adapters.find((a): a is SeerrAdapter => a instanceof SeerrAdapter);

    registerDiagnose(server, { adapters, library });
    registerStackHealth(server, adapters, instances);
    registerGetIndexers(server, adapters.find(hasIndexers));
    registerGetSubtitles(server, adapters.filter(hasSubtitles));
    registerGetQueue(server, adapters);
    registerGetCalendar(server, adapters);
    registerGetPlayback(server, jellyfin, jellyfinIdentity);
    registerGetRequests(server, seerr, seerrIdentity);
    registerGetMediaDetails(server, adapters, library, dataset);
    registerGetLibrary(server, library);
    registerSearchMedia(server, adapters, dataset);
    registerLookupMedia(server, adapters, dataset);
    registerDiscoverMedia(server, seerr, dataset);

    // Registered unconditionally like every read tool, and for the same §18
    // reason: the tool surface is the public API and must not depend on
    // configuration. A stack with no write permission still *has*
    // trigger_search — it refuses, naming the key to set, which is a far better
    // answer than a tool the model was told about and cannot find.
    registerTriggerSearch(server, write, adapters);
    registerTriggerScan(server, write, adapters);
    registerRemoveQueueItem(server, write, adapters);
    registerDeleteMedia(server, write, adapters);
    registerRespondToRequest(server, write, adapters);
    registerDeleteRequest(server, write, adapters);
    registerAddMedia(server, write, adapters);
}

/**
 * The tool surface, frozen at 1.0.
 *
 * Renaming or removing any of these breaks every user's saved prompts
 * *silently* — the model stops finding the tool rather than raising an error —
 * so from 1.0 onward it takes a major version. Adding one is a minor.
 */
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
    'discover_media',
    'trigger_search',
    'trigger_scan',
    'remove_queue_item',
    'delete_media',
    'respond_to_request',
    'delete_request',
    'add_media'
] as const;
