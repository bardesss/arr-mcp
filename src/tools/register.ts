import { listInstances } from '../config/instances.ts';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Config, MultiUserServiceConfig, ServiceId } from '../config/schema.ts';
import type { WriteAudit } from '../core/audit.ts';
import type { ImdbDataset } from '../metadata/imdbDataset.ts';
import type { ConfirmTokens } from '../core/confirm.ts';
import { IdentityResolver } from '../core/identity.ts';
import type { ServiceInstance } from '../config/instances.ts';
import { permissionSourceFrom } from '../core/permissions.ts';
import { SeerrAdapter } from '../services/seerr.ts';
import {
    hasIndexers,
    hasPlayback,
    hasSubtitles,
    hasUserDirectory,
    hasUserLibrary,
    type MediaServerAdapter,
    type ServiceAdapter
} from '../services/types.ts';
import { registerAddMedia } from './addMedia.ts';
import { registerDeleteEpisodeFiles } from './deleteEpisodeFiles.ts';
import { registerCleanQueue } from './cleanQueue.ts';
import { registerDeleteMedia } from './deleteMedia.ts';
import { registerDiagnose } from './diagnose/index.ts';
import { registerDiscoverMedia } from './discoverMedia.ts';
import { registerGetBlocklist } from './getBlocklist.ts';
import { registerGetCalendar } from './getCalendar.ts';
import { registerGetHistory } from './getHistory.ts';
import { registerGetIndexers } from './getIndexers.ts';
import { registerGetLibrary } from './getLibrary.ts';
import { registerGetMediaDetails } from './getMediaDetails.ts';
import { registerGetPlayback } from './getPlayback.ts';
import { registerGetQueue } from './getQueue.ts';
import { registerGetReleases } from './getReleases.ts';
import { registerGetRequests } from './getRequests.ts';
import { registerGetSubtitles } from './getSubtitles.ts';
import { registerGetWanted } from './getWanted.ts';
import { registerGrabRelease } from './grabRelease.ts';
import { LibraryLoader } from './library.ts';
import { registerLookupMedia } from './lookupMedia.ts';
import { registerDeleteRequest, registerRespondToRequest } from './manageRequests.ts';
import { registerPauseDownloads } from './pauseDownloads.ts';
import { registerRemoveBlocklistItem } from './removeBlocklistItem.ts';
import { registerRemoveQueueItem } from './removeQueueItem.ts';
import { registerRequestMedia } from './requestMedia.ts';
import { registerSearchMedia } from './searchMedia.ts';
import { registerSetMonitoring } from './setMonitoring.ts';
import { registerSetWatched } from './setWatched.ts';
import { registerStackHealth } from './stackHealth.ts';
import { registerTriggerScan } from './triggerScan.ts';
import { registerTriggerSubtitleSearch } from './triggerSubtitleSearch.ts';
import { registerTriggerSearch } from './triggerSearch.ts';
import { registerUpdateMedia } from './updateMedia.ts';
import type { WriteContext } from './write.ts';

/**
 * Identity resolvers built once, here, rather than inside the per-request
 * server factory: they cache the service's user directory, and rebuilding them
 * per request would refetch it on every tool call.
 */
export type ToolContext = {
    adapters: readonly ServiceAdapter[];
    /** Jellyfin's or Plex's, whichever is configured — never both. */
    mediaServerIdentity: IdentityResolver | undefined;
    seerrIdentity: IdentityResolver | undefined;
    library: LibraryLoader;
    /**
     * The IMDb dataset, when configured.
     *
     * `library` already closes over it — the owned-library join happens there
     * exactly once. This field is for the tools that answer about things you
     * may *not* own, which never touch the library index: search, lookup and
     * details. Spec calls that the path that matters most, because a
     * rating is usually wanted before deciding to add something.
     */
    dataset: ImdbDataset | undefined;
    /** Every configured instance, as the config declares it — the source the
     *  write gate reads, so `stack_health` cannot report a different answer. */
    instances: readonly ServiceInstance[];
    /**
     * The write half. Built once alongside the resolvers rather than per
     * request: `ConfirmTokens` holds the signing key and the spent-token set,
     * and rebuilding it per request would make every confirmation token invalid
     * the moment it was issued — the handshake spans two calls by construction.
     */
    write: WriteContext;
};

/**
 * The one media server, or none.
 *
 * Throws on a second rather than picking: `get_library`'s `presence` asks
 * whether the *other side* can see a file, and with two media servers that
 * question has no single answer. The config schema refuses the pair, so
 * reaching here means a path that bypassed it.
 *
 * The filter is `hasPlayback` **or** `hasUserLibrary`, not `hasPlayback`
 * alone: `library.ts` and `diagnose/evidence.ts` both select their media
 * server by `hasUserLibrary`. An adapter with a library read and no
 * playback used to pass neither branch here (returning `undefined`, no
 * throw) while those two treated it as configured — `get_playback` said
 * "no media server" about the exact adapter `get_library` was reading.
 * Widening the filter means that disagreement is now a startup-time throw,
 * naming the missing capability, instead of a runtime contradiction between
 * tools.
 */
function theMediaServer(adapters: readonly ServiceAdapter[]): MediaServerAdapter | undefined {
    const found = adapters.filter(a => hasPlayback(a) || hasUserLibrary(a));
    if (found.length > 1) {
        throw new Error(
            `only one media server may be configured, found ${found.map(a => a.id).join(', ')}`
        );
    }
    const candidate = found[0];
    if (candidate === undefined) return undefined;

    // Neither capability alone makes something a full media server — a
    // candidate missing any of the three must say so by name, not fail later
    // with a raw "listUsers is not a function" at the IdentityResolver call
    // site, or a silent disagreement between tools.
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

/**
 * The media server's own config block, keyed by its adapter `type` rather
 * than a hardcoded `services.jellyfin`.
 *
 * That hardcoding was the Critical bug: a Plex-only stack built its resolver
 * from `config.services.jellyfin`, which is always undefined there, so
 * `get_playback` answered "no media server" and `get_library` reported Plex
 * permanently degraded — both about a media server that was configured and
 * healthy. `config.services` has a different shape per key, so this hand
 * narrows `type` rather than indexing it, which would need an unsound cast.
 */
function mediaServerConfig(type: ServiceId, services: Config['services']): MultiUserServiceConfig | undefined {
    if (type === 'jellyfin') return services.jellyfin;
    if (type === 'plex') return services.plex;
    return undefined;
}

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
    dataset?: ImdbDataset
): ToolContext {
    const mediaServer = theMediaServer(adapters);
    const seerr = adapters.find((a): a is SeerrAdapter => a instanceof SeerrAdapter);

    const mediaServerConfigBlock = mediaServer === undefined ? undefined : mediaServerConfig(mediaServer.type, config.services);
    const mediaServerIdentity =
        mediaServer !== undefined && mediaServerConfigBlock !== undefined
            ? new IdentityResolver(mediaServer, mediaServerConfigBlock)
            : undefined;

    const library = new LibraryLoader(adapters, mediaServerIdentity, undefined, dataset);

    return {
        adapters,
        dataset,
        instances: listInstances(config),
        mediaServerIdentity,
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
 * Tools whose service is not configured are **still registered**: reads return
 * an empty result, writes refuse with a remedy. Hiding a tool would make
 * the surface depend on configuration, and treats the tool
 * surface as the public API — a model that learned `get_subtitles` exists must
 * not find it missing after a config edit.
 */
export function registerAllTools(server: McpServer, context: ToolContext): void {
    const { adapters, dataset, instances, mediaServerIdentity, seerrIdentity, library, write } = context;
    const mediaServer = theMediaServer(adapters);
    const seerr = adapters.find((a): a is SeerrAdapter => a instanceof SeerrAdapter);

    registerDiagnose(server, { adapters, library });
    registerStackHealth(server, adapters, instances);
    registerGetIndexers(server, adapters.find(hasIndexers));
    registerGetSubtitles(server, adapters.filter(hasSubtitles));
    registerGetQueue(server, adapters);
    registerGetHistory(server, adapters);
    registerGetWanted(server, adapters);
    registerGetReleases(server, adapters);
    registerGetBlocklist(server, adapters);
    registerGetCalendar(server, adapters);
    registerGetPlayback(server, mediaServer, mediaServerIdentity);
    registerGetRequests(server, seerr, seerrIdentity);
    registerGetMediaDetails(server, adapters, library, dataset);
    registerGetLibrary(server, library);
    registerSearchMedia(server, adapters, dataset);
    registerLookupMedia(server, adapters, dataset);
    registerDiscoverMedia(server, seerr, dataset);

    // Registered unconditionally like every read tool, and for the same 
    // reason: the tool surface is the public API and must not depend on
    // configuration. A stack with no write permission still *has*
    // trigger_search — it refuses, naming the key to set, which is a far better
    // answer than a tool the model was told about and cannot find.
    registerTriggerSearch(server, write, adapters);
    registerTriggerScan(server, write, adapters);
    registerTriggerSubtitleSearch(server, write, adapters);
    registerRemoveQueueItem(server, write, adapters);
    registerCleanQueue(server, write, adapters);
    registerDeleteMedia(server, write, adapters);
    registerDeleteEpisodeFiles(server, write, adapters);
    registerSetMonitoring(server, write, adapters);
    registerRespondToRequest(server, write, adapters, seerrIdentity);
    registerDeleteRequest(server, write, adapters, seerrIdentity);
    registerAddMedia(server, write, adapters);
    registerUpdateMedia(server, write, adapters);
    registerGrabRelease(server, write, adapters);
    registerRequestMedia(server, write, adapters, seerrIdentity);
    registerPauseDownloads(server, write, adapters);
    registerSetWatched(server, write, adapters, mediaServerIdentity);
    registerRemoveBlocklistItem(server, write, adapters);
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
    'get_history',
    'get_wanted',
    'get_releases',
    'get_blocklist',
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
    'trigger_subtitle_search',
    'remove_queue_item',
    'clean_queue',
    'delete_media',
    'delete_episode_files',
    'set_monitoring',
    'respond_to_request',
    'delete_request',
    'add_media',
    'update_media',
    'grab_release',
    'request_media',
    'pause_downloads',
    'set_watched',
    'remove_blocklist_item'
] as const;
