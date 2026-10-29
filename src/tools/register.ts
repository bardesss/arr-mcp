import { listInstances } from '../config/instances.ts';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Config } from '../config/schema.ts';
import type { WriteAudit } from '../core/audit.ts';
import type { ImdbDataset } from '../metadata/imdbDataset.ts';
import type { ConfirmTokens } from '../core/confirm.ts';
import { IdentityResolver } from '../core/identity.ts';
import type { ServiceInstance } from '../config/instances.ts';
import { permissionSourceFrom } from '../core/permissions.ts';
import { SeerrAdapter } from '../services/seerr.ts';
import {
    hasBookMetadata,
    hasBookMetadataIssues,
    hasIndexers,
    hasSubtitles,
    type ServiceAdapter
} from '../services/types.ts';
import { bothIds, selectMediaServers, type MediaServers } from './mediaServers.ts';
import { buildCrossChecker } from './crossChecks.ts';
import { registerAddMedia } from './addMedia.ts';
import { registerDeleteEpisodeFiles } from './deleteEpisodeFiles.ts';
import { registerCleanQueue } from './cleanQueue.ts';
import { registerDeleteMedia } from './deleteMedia.ts';
import { registerDiagnose } from './diagnose/index.ts';
import { registerDiscoverMedia } from './discoverMedia.ts';
import { registerFixMetadata } from './fixMetadata.ts';
import { registerGetBlocklist } from './getBlocklist.ts';
import { registerGetCalendar } from './getCalendar.ts';
import { registerGetHistory, type EventLog } from './getHistory.ts';
import { registerGetIndexers } from './getIndexers.ts';
import { registerGetInstanceOptions } from './instanceOptions.ts';
import { registerGetLibrary } from './getLibrary.ts';
import { registerGetMediaDetails } from './getMediaDetails.ts';
import { registerGetMetadataIssues } from './getMetadataIssues.ts';
import { registerGetPlayback } from './getPlayback.ts';
import { registerGetProfileIssues } from './profileIssues/index.ts';
import { registerGetQueue } from './getQueue.ts';
import { registerGetReleases } from './getReleases.ts';
import { registerGetRequests } from './getRequests.ts';
import { registerGetSubtitles } from './getSubtitles.ts';
import { registerGetWanted } from './getWanted.ts';
import { registerGrabRelease } from './grabRelease.ts';
import { LibraryLoader } from './library.ts';
import { registerLookupMedia } from './lookupMedia.ts';
import { registerDeleteRequest, registerRespondToRequest } from './manageRequests.ts';
import { registerDeleteIndexer, registerManageIndexer } from './manageIndexer.ts';
import { registerUpdateBook } from './updateBook.ts';
import { registerImportDownload } from './importDownload.ts';
import { registerBlocklistMedia } from './blocklistMedia.ts';
import { registerPauseDownloads } from './pauseDownloads.ts';
import { registerRetryDownload } from './retryDownload.ts';
import { registerRemoveBlocklistItem } from './removeBlocklistItem.ts';
import { registerRemoveQueueItem } from './removeQueueItem.ts';
import { registerRequestMedia } from './requestMedia.ts';
import { registerSearchMedia } from './searchMedia.ts';
import { registerSetMonitoring } from './setMonitoring.ts';
import { registerSetWatched } from './setWatched.ts';
import { registerStackHealth } from './stackHealth.ts';
import { registerSyncDatabase } from './syncDatabase.ts';
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
    /** The primary media server's identity; `mediaServers.primary?.identity`. */
    mediaServerIdentity: IdentityResolver | undefined;
    /** Primary is what every tool defaults to. */
    mediaServers: MediaServers;
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
    /** Added per request by the app, which owns the store and reads the setting from the current config. */
    eventLog?: EventLog;
    /** Every configured instance, as the config declares it — the source the
     *  write gate reads, so `stack_health` cannot report a different answer. */
    instances: readonly ServiceInstance[];
    /** `tools.media_cards`: build MCP Apps poster cards at all (`mcp/apps.ts`). */
    mediaCards: boolean;
    /**
     * The write half. Built once alongside the resolvers rather than per
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
    dataset?: ImdbDataset
): ToolContext {
    const mediaServers = selectMediaServers(adapters, config);
    const seerr = adapters.find((a): a is SeerrAdapter => a instanceof SeerrAdapter);
    const mediaServerIdentity = mediaServers.primary?.identity;

    const library = new LibraryLoader(
        adapters,
        mediaServerIdentity,
        undefined,
        dataset,
        mediaServers.primary === undefined
            ? undefined
            : {
                  primaryId: mediaServers.primary.adapter.id,
                  ...(mediaServers.secondary === undefined
                      ? {}
                      : {
                            secondary: {
                                id: mediaServers.secondary.adapter.id,
                                identity: mediaServers.secondary.identity
                            }
                        })
              }
    );

    return {
        adapters,
        dataset,
        instances: listInstances(config),
        mediaCards: config.tools?.media_cards !== false,
        mediaServerIdentity,
        mediaServers,
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
            library,
            crossChecks: buildCrossChecker(adapters, library)
        }
    };
}

/**
 * One registration point.
 *
 * Every tool is registered here, configured or not: reads return an empty
 * result, writes refuse with a remedy. What a client is *sent* is narrowed
 * afterwards by `shapeToolSurface`: a write whose services are all missing is
 * left out, and with `tools.hide_unusable` so is a read.
 */
export function registerAllTools(server: McpServer, context: ToolContext): void {
    const { adapters, dataset, instances, seerrIdentity, library, write } = context;
    const seerr = adapters.find((a): a is SeerrAdapter => a instanceof SeerrAdapter);

    const primary = bothIds(context.mediaServers)?.[0];
    registerDiagnose(server, {
        adapters,
        library,
        ...(seerrIdentity === undefined ? {} : { seerrIdentity }),
        ...(primary === undefined ? {} : { primaryMediaServer: primary }),
        ...(context.eventLog === undefined ? {} : { events: context.eventLog.store })
    });
    registerStackHealth(server, adapters, instances, primary);
    registerGetInstanceOptions(server, adapters);
    registerGetIndexers(server, adapters.filter(hasIndexers));
    registerGetSubtitles(server, adapters.filter(hasSubtitles));
    registerGetQueue(server, adapters);
    registerGetHistory(server, adapters, context.eventLog);
    registerGetWanted(server, adapters);
    registerGetReleases(server, adapters, library);
    registerGetBlocklist(server, adapters);
    registerGetCalendar(server, adapters);
    registerGetPlayback(server, context.mediaServers);
    registerGetRequests(server, seerr, seerrIdentity);
    registerGetMediaDetails(server, adapters, library, dataset, bothIds(context.mediaServers), context.mediaCards);
    registerGetMetadataIssues(server, context.mediaServers, write.permissions, library, adapters.find(hasBookMetadataIssues));
    registerGetLibrary(server, library, bothIds(context.mediaServers), adapters, context.mediaCards);
    registerGetProfileIssues(server, adapters, instances);
    registerSearchMedia(server, adapters, dataset, context.mediaCards);
    registerLookupMedia(server, adapters, dataset, context.mediaCards);
    registerDiscoverMedia(server, seerr, dataset);

    // A stack with no write permission still *has* trigger_search: it refuses,
    // naming the key to set. Only a write with no service configured at all
    // is left out of `tools/list` (`shapeToolSurface`).
    registerTriggerSearch(server, write, adapters);
    registerTriggerScan(server, write, adapters);
    registerTriggerSubtitleSearch(server, write, adapters);
    registerRemoveQueueItem(server, write, adapters);
    registerCleanQueue(server, write, adapters);
    registerDeleteMedia(server, write, adapters);
    registerDeleteEpisodeFiles(server, write, adapters);
    registerSetMonitoring(server, write, adapters, library);
    registerRespondToRequest(server, write, adapters, seerrIdentity);
    registerDeleteRequest(server, write, adapters, seerrIdentity);
    registerAddMedia(server, write, adapters);
    registerUpdateMedia(server, write, adapters);
    registerGrabRelease(server, write, adapters);
    registerRequestMedia(server, write, adapters, seerrIdentity);
    registerPauseDownloads(server, write, adapters);
    registerRetryDownload(server, write, adapters);
    registerSyncDatabase(server, write, adapters);
    registerSetWatched(
        server,
        write,
        adapters,
        [context.mediaServers.primary, context.mediaServers.secondary].find(c => c?.adapter.type === 'jellyfin')?.identity,
        bothIds(context.mediaServers),
        library
    );
    registerFixMetadata(server, write, context.mediaServers, library, undefined, adapters.find(hasBookMetadata), adapters);
    registerRemoveBlocklistItem(server, write, adapters);
    registerManageIndexer(server, write, adapters);
    registerUpdateBook(server, write, adapters);
    registerImportDownload(server, write, adapters);
    registerDeleteIndexer(server, write, adapters);
    registerBlocklistMedia(server, write, adapters);
}

/** The tools that write (`readOnlyHint: false`). `shapeToolSurface` hides these when none of their services is configured. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
    'add_media',
    'blocklist_media',
    'clean_queue',
    'delete_episode_files',
    'delete_indexer',
    'delete_media',
    'delete_request',
    'fix_metadata',
    'grab_release',
    'import_download',
    'manage_indexer',
    'pause_downloads',
    'remove_blocklist_item',
    'remove_queue_item',
    'request_media',
    'respond_to_request',
    'retry_download',
    'set_monitoring',
    'set_watched',
    'sync_database',
    'trigger_scan',
    'trigger_search',
    'trigger_subtitle_search',
    'update_book',
    'update_media'
]);

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
    'get_instance_options',
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
    'get_metadata_issues',
    'get_library',
    'get_profile_issues',
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
    'retry_download',
    'sync_database',
    'set_watched',
    'fix_metadata',
    'remove_blocklist_item',
    'manage_indexer',
    'update_book',
    'import_download',
    'delete_indexer',
    'blocklist_media'
] as const;
