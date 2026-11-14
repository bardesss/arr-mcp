import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { type ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import { MUSICBRAINZ_ID } from '../services/lidarr.ts';
import { NOT_RETRYABLE } from '../services/shelfmark.ts';
import {
    hasMediaAdd,
    hasQueue,
    hasRetry,
    hasMetadataProfiles,
    hasReleaseGrab,
    hasReleaseSearch,
    type ArtistMonitorNewItems,
    type MediaAddCapable,
    type QualityProfile,
    type ReleaseGrabCapable,
    type ReleaseSearchCapable,
    type ServiceAdapter
} from '../services/types.ts';
import { chooseOne, freeSpace, FOLDER_MATCH, PROFILE_MATCH, TAG_MATCH } from './chooseOne.ts';
import { RANK_NONE, rankTitle, splitYear, unfenced } from '../core/titleMatch.ts';
import type { AddCandidate, RootFolder } from '../services/types.ts';
import { arrSubject } from './crossChecks.ts';
import { NO_ALBUMS_PROFILE, SEARCH_AFTER_REFRESH } from './lidarrProfiles.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';
import { titled } from '../core/labels.ts';
import { targetInput, serviceTarget } from './serviceTarget.ts';
import { topRelease } from './grabRelease.ts';

/**
 * The last of the writes, and the only one that has to *choose*
 * something on the user's behalf.
 *
 * Adding needs a quality profile and a root folder, and neither has a
 * defensible default this code could invent. So the rule is: if there is
 * exactly one, use it silently; there was no choice to make. If there are
 * several and the caller named none, **refuse and list them**. Picking the
 * first of four quality profiles would be a guess presented as a decision, and
 * the user would discover it as a 4K film filling a disk they meant to keep
 * for 1080p.
 *
 * Safe tier: an added item can be removed again with `delete_media`. It still
 * says in the preview that it will start downloading, because "add" reads
 * cheaper than it is.
 */

/** Shelfmark adds a book by queueing a release: it has no library of its own to add to. */
type BookGrab = ServiceAdapter & ReleaseSearchCapable & ReleaseGrabCapable;
const canAdd = (a: ServiceAdapter): a is (ServiceAdapter & MediaAddCapable) | BookGrab =>
    hasMediaAdd(a) || (a.type === 'shelfmark' && hasReleaseSearch(a) && hasReleaseGrab(a));

const TARGET = serviceTarget({
    services: ['radarr', 'sonarr', 'whisparr', 'lidarr', 'shelfmark'],
    can: canAdd,
    cannot: 'cannot add media',
    hint: 'Radarr adds films by TMDB id, Sonarr and Whisparr series or a site by TVDB id, Lidarr artists by MusicBrainz id, and Shelfmark books by the id of a search_media `source: "discover"` row.'
});

/**
 * An *arr option on a book. Refused for the same reason as on the wrong *arr:
 * dropping it would add something other than what was asked for.
 */
function refuseBookOptions(service: ServiceId, given: Record<string, unknown>): void {
    const named = Object.keys(given).find(key => given[key] !== undefined);
    if (named === undefined) return;
    throw new ServiceError('NotFound', service, `${named} is not a book option`, {
        remedy: 'A book has no quality profile, root folder, monitoring or tags to set: Shelfmark queues the most-downloaded file for it. Drop the option, or choose a file yourself with get_releases and grab_release.'
    });
}

/**
 * Lidarr's monitored check is skipped during any search (nothing sets
 * `MonitoredEpisodesOnly`) and otherwise rejects an unmonitored artist
 * (`MonitoredAlbumSpecification`), so RSS sync skips one. Lidarr's own missing
 * and cutoff searches leave it out in their queries (`AlbumSearchService`).
 * `trigger_search` does neither, though a whole-artist search takes only the
 * monitored albums (`ReleaseSearchService.ArtistSearch`).
 */
function monitoredEffect(monitored: boolean, lidarr: boolean, noAlbums: boolean): string {
    if (!lidarr) {
        return monitored
            ? 'Monitors it, so it will be grabbed when a matching release appears.'
            : 'Adds it unmonitored, so nothing will be grabbed until you monitor it.';
    }
    // An artist's own flag grabs nothing by itself: its albums carry their own,
    // which the lines below this one describe.
    // Monitoring changes nothing under `None`: there is no album to grab
    // until the artist gets a monitored one, from another profile (the next
    // refresh flags new albums by `monitorNewItems`) or an album added by
    // hand, which a refresh keeps (`RefreshAlbumService.ShouldDelete`).
    if (monitored && noAlbums) {
        return 'Monitors the artist, but the None metadata profile gives it no albums, so nothing is grabbed until it has monitored ones, from another metadata profile or an album added in Lidarr.';
    }
    if (noAlbums) {
        return 'Adds it unmonitored, and the None metadata profile gives it no albums, so monitoring it alone grabs nothing: it needs monitored albums first, from another metadata profile or an album added in Lidarr.';
    }
    if (monitored) return 'Monitors the artist, so Lidarr grabs its monitored albums when a matching release appears.';
    return "Adds it unmonitored, so Lidarr's RSS sync and its own automatic searches grab nothing for it until you monitor it. A search started with trigger_search skips that check, so it can still grab the artist's monitored albums, or any album it names.";
}

/**
 * Lidarr's search on add is `MissingAlbumSearchCommand` (`ArtistScannedHandler`),
 * run after the album flags are set: monitored albums of a monitored artist,
 * already released, with a track missing (`AlbumSearchService`,
 * `AlbumsWithoutFilesBuilder`). `future` unmonitors every released album
 * (`AlbumMonitoredService`), and with no `monitor` the `none` rule leaves
 * every album unmonitored (see `lidarrInitialAlbums`), so either leaves that
 * search nothing to look for.
 */
function searchEffect(
    searchNow: boolean,
    lidarr: boolean,
    monitored: boolean,
    monitor: string | undefined,
    newItems: ArtistMonitorNewItems | undefined,
    noAlbums: boolean
): string {
    if (noAlbums) return 'The None metadata profile gives the artist no albums, so nothing is searched.';
    if (!searchNow) return 'Does not search yet. Use trigger_search when you want it to look.';
    if (!lidarr) return 'Starts searching immediately. This may begin a download, using disk space and bandwidth.';
    if (!monitored) return "Lidarr's search on add skips an unmonitored artist, so nothing is searched yet. Use trigger_search when you want it to look.";
    if (monitor === 'future') {
        return "Lidarr's search on add looks only for monitored albums already released, and `future` monitors none of those, so nothing is searched yet.";
    }
    if (monitor === undefined && newItems === 'none') {
        return "Lidarr's search on add looks only for monitored albums, and none is monitored, so nothing is searched yet.";
    }
    return 'Starts searching for its monitored albums that are already released and missing a track. This may begin a download, using disk space and bandwidth.';
}

/**
 * The same rules under `None`, where the artist has no album: a later profile
 * change brings its albums in at the next refresh, flagged by the rule, and
 * `new` finds nothing to compare with, so it monitors every one
 * (`MonitorNewAlbumService`). A refresh of a monitored artist then searches the
 * monitored albums it added that are already released: all of them up to
 * 3.2.0.5144 (`AlbumAddedService`), and in later versions just those released
 * in the last 180 days (`AlbumRefreshedService`), where the older ones wait for
 * RSS sync or a search started by hand.
 */
const NO_ALBUMS_NEW_ITEMS_EFFECT: Readonly<Record<ArtistMonitorNewItems, string>> = {
    all: `If its metadata profile changes later, every album that brings is monitored (\`all\`). ${SEARCH_AFTER_REFRESH}`,
    new: `If its metadata profile changes later, every album that brings is monitored: \`new\` compares with the albums it already has, and it has none. ${SEARCH_AFTER_REFRESH}`,
    none: 'If its metadata profile changes later, the albums that brings are not monitored (`none`).'
};

/** What each of Lidarr's rules for albums found later does, in the preview. */
const NEW_ITEMS_EFFECT: Readonly<Record<ArtistMonitorNewItems, string>> = {
    all: 'Albums Lidarr discovers later are monitored.',
    new: 'Albums Lidarr discovers later are monitored only when released on or after the newest album it already has.',
    none: 'Albums Lidarr discovers later are not monitored.'
};

/** `future` with the `none` rule, which replaces the preview's `future` line. */
const NOTHING_MONITORED_FUTURE =
    'Monitors no album, now or later: `future` unmonitors every released album and every album with files, and the rest start unmonitored by the `none` rule.';

/**
 * The rule for new albums also sets the albums an artist is added with: the
 * first refresh adds every album, each flagged by `monitorNewItems`
 * (`RefreshArtistService.ProcessChildren`, `MonitorNewAlbumService`, where
 * `new` monitors an album when no album is there yet). `monitor` then
 * overrides that, but `future`, `missing` and `existing` set only albums with
 * files and released albums (`AlbumMonitoredService`: a release date on or
 * before now), so an album with no files that is not yet released or has no
 * date keeps the rule's flag. Omitted, the rule is the lookup's `all`.
 */
function lidarrInitialAlbums(monitor: string | undefined, newItems: ArtistMonitorNewItems | undefined): string | undefined {
    if (monitor === undefined && newItems === 'none') {
        return 'Monitors none of its albums: with no `monitor`, Lidarr sets the albums it is added with by `monitor_new_items` too.';
    }
    if (monitor === undefined && newItems === 'new') {
        return 'Monitors every album it is added with: with no `monitor`, Lidarr sets those by `monitor_new_items` too, and for an artist being added every album counts as new.';
    }
    if (newItems === 'none' && monitor === 'future') return NOTHING_MONITORED_FUTURE;
    if (monitor === 'missing' || monitor === 'existing') {
        const rule = newItems ?? 'all';
        const flag = rule === 'none' ? 'starts unmonitored' : 'stays monitored';
        return `An album with no files that is not yet released or has no release date ${flag}, by the \`${rule}\` rule: \`${monitor}\` sets only albums with files and released ones.`;
    }
    return undefined;
}

/** Lidarr's metadata profile, for the preview's first line; nothing elsewhere. */
function metadataProfileNote(profile: QualityProfile | undefined, fromFolder: boolean): string {
    if (profile === undefined) return '';
    const noAlbums = profile.name === NO_ALBUMS_PROFILE ? ', which gives the artist no albums' : '';
    return `, metadata profile ${profile.display} (id ${profile.id})${fromFolder ? ", the root folder's default" : ''}${noAlbums}`;
}

/**
 * Named, a metadata profile resolves like a quality profile; omitted, the root
 * folder's own default stands in for the name, and failing that the
 * one-or-refuse rule applies to every profile but `None`.
 */
function chooseMetadataProfile(
    profiles: readonly QualityProfile[],
    named: string | undefined,
    folderDefault: QualityProfile | undefined,
    service: ServiceId
): QualityProfile {
    const requested = named ?? (folderDefault === undefined ? undefined : String(folderDefault.id));
    const options = requested === undefined ? profiles.filter(p => p.name !== NO_ALBUMS_PROFILE) : profiles;
    if (options.length === 0 && profiles.length > 0) {
        throw new ServiceError('NotFound', service, `${service} has only its reserved None metadata profile, which gives an artist no albums`, {
            remedy: 'Add a metadata profile in Lidarr\'s own settings, or name `metadata_profile: "None"` to add the artist with no albums.'
        });
    }
    return chooseOne(options, requested, PROFILE_MATCH, p => `${p.display} (id ${p.id})`, 'metadata profile', service);
}

/**
 * The external id's shape, checked before any call: an integer for the
 * services that add by TMDB or TVDB id, a GUID for Lidarr's MusicBrainz id.
 * `Number()` alone would accept `1e2` or `0x10` and add whatever that is.
 */
function refuseMalformedId(service: ServiceId, type: ServiceId, externalId: string): void {
    if (type === 'lidarr') {
        if (MUSICBRAINZ_ID.test(externalId)) return;
        throw new ServiceError('NotFound', service, `"${externalId}" is not a MusicBrainz artist id`, {
            remedy: 'Lidarr adds an artist by its MusicBrainz id, a GUID. search_media `source: "discover"` returns one under `ids.mbid`.'
        });
    }
    if (/^\d+$/.test(externalId) && Number(externalId) > 0) return;
    // The same words `lookupArrForAdd` uses for the same refusal.
    const provider = type === 'radarr' ? 'tmdb' : 'tvdb';
    throw new ServiceError('NotFound', service, `"${externalId}" is not a ${provider} id`, {
        remedy: `${service} adds by ${provider} id, which is a positive integer. search_media \`source: "discover"\` returns one under \`ids.${provider}\`.`
    });
}

const trimSlash = (p: string): string => p.replace(/[\\/]+$/, '');

/**
 * The root folder `path` sits in (#535). Radarr and Sonarr keep the root
 * beside the item's own folder, so a folder outside every root is refused
 * rather than added under a root it is not in.
 */
export function rootOf(folders: readonly RootFolder[], path: string, service: string): RootFolder {
    const wanted = trimSlash(path);
    // `/movies/../etc` would pass a prefix test, so dot segments are refused
    // outright, and the folder must be the root's own child, as Radarr and
    // Sonarr lay a title out.
    const dotted = wanted.split(/[\\/]/).some(segment => segment === '.' || segment === '..');
    const hit = dotted
        ? undefined
        : folders.find(f => {
              const root = trimSlash(f.path);
              const rest = wanted.slice(root.length);
              return wanted.startsWith(root) && /^[\\/][^\\/]+$/.test(rest);
          });
    if (hit !== undefined) return hit;
    throw new ServiceError('NotFound', service, `${JSON.stringify(path)} is not a folder directly inside a ${service} root folder`, {
        remedy: `Pass the title's own folder, directly inside one of ${folders.map(f => f.display).join(', ') || 'its root folders'}, as ${service} sees the disk.`
    });
}

const FOLDER_ID: Record<string, RegExp> = { radarr: /tmdb(?:id)?-(\d+)/i, sonarr: /tvdb(?:id)?-(\d+)/i, whisparr: /tvdb(?:id)?-(\d+)/i };

/**
 * Why a folder may hold another title than the one being added: an id or a
 * year in its name that disagrees, or a name that shares nothing with the
 * title. Undefined when nothing disagrees. The wrong-match case of #535: an
 * old folder without an id that the media server matched to another film.
 */
function folderDoubt(path: string, candidate: AddCandidate, type: string, externalId: string): string | undefined {
    const name = trimSlash(path).split(/[\\/]/).pop() ?? '';
    const id = FOLDER_ID[type]?.exec(name)?.[1];
    if (id !== undefined && id !== externalId) return `the folder name carries id ${id}, not ${externalId}`;
    const bare = name.replace(/[[{][^\]}]*[\]}]/g, ' ').trim();
    const { title, year } = splitYear(bare);
    if (year !== undefined && candidate.year !== undefined && year !== candidate.year) return `the folder name says ${year}, the lookup ${candidate.year}`;
    if (title !== '' && rankTitle(unfenced(candidate.title), title) === RANK_NONE && rankTitle(title, unfenced(candidate.title)) === RANK_NONE) {
        return 'the folder name does not match the title';
    }
    return undefined;
}

const AddMediaInput = z.object({
    ...targetInput(TARGET, '{{or: radarr=radarr for a film; sonarr=sonarr for a series; whisparr=whisparr for a site; lidarr=lidarr for an artist; shelfmark=shelfmark for a book}}.'),
    external_id: z
        .string()
        .min(1)
        .describe(
            '[[radarr|sonarr|whisparr: The {{or: radarr=TMDB id for radarr; sonarr|whisparr=TVDB id for sonarr or whisparr}}, as an integer string.]] [[lidarr: The MusicBrainz artist id, a GUID, for lidarr.]] [[shelfmark: For a book, the `id` of its search row.]] From search_media `source: "discover"`.'
        ),
    quality_profile: z
        .string()
        .optional()
        .describe('Profile name or id. Optional only when the service has exactly one.'),
    root_folder: z
        .string()
        .optional()
        .describe('Root folder path, or any distinctive part of it. Optional only when the service has exactly one.'),
    monitored: z.boolean().default(true).describe('Monitor it for downloads. Defaults to true.'),
    monitor: z
        .enum(['all', 'future', 'missing', 'existing', 'firstSeason', 'lastSeason', 'pilot', 'first', 'latest', 'none'])
        .optional()
        .describe(
            '[[sonarr|whisparr: {{or: sonarr=Sonarr; whisparr=Whisparr}}: which seasons to monitor. `future` is "only what has not aired yet", `all` is everything, `none` monitors the series but no season.]] [[whisparr: `pilot` is Sonarr only: a site has no pilot scene.]] [[lidarr: Lidarr: which albums, `first` or `latest` album, or `all`, `future`, `missing`, `existing` or `none`; `firstSeason`, `lastSeason` and `pilot` are refused there, and `first` and `latest` everywhere else.]] Omit for the service\'s own default. [[radarr: Radarr has no seasons: use `monitored` there.]]'
        ),
    monitor_new_items: z
        .enum(['all', 'none', 'new'])
        .optional()
        .describe(
            '[[lidarr: Lidarr only: the rule for albums Lidarr discovers later: `all`, `new` (only ones released on or after the newest album it already has) or `none`, as on update_media. With no `monitor`, it also sets the albums the artist is added with. Omitted, the artist gets `all`: the root folder\'s own default applies only to an artist Lidarr adds on import.]][[sonarr:  Sonarr: `all` (the default) or `none`, whether seasons it finds later are monitored.]]'
        ),
    metadata_profile: z
        .string()
        .optional()
        .describe(
            '[[lidarr: Lidarr only: metadata profile name or id, which decides the album types and release statuses the artist gets. Optional when the root folder names a default, or when Lidarr has only one besides its reserved `None`, which gives an artist no albums and is used only when named or set as the root folder\'s default.]]'
        ),
    minimum_availability: z
        .enum(['announced', 'inCinemas', 'released'])
        .optional()
        .describe(
            '[[radarr: Radarr only: how early it may grab. Defaults to `released`, which is what stops a brand-new film grabbing a cinema recording the day it is announced.]]'
        ),
    series_type: z
        .enum(['standard', 'daily', 'anime'])
        .optional()
        .describe('[[sonarr: Sonarr only: the numbering scheme. `anime` for absolute numbering, `daily` for date-based.]]'),
    tags: z
        .array(z.string().min(1))
        .optional()
        .describe(
            'Tag labels or ids the service already has. An unknown label is refused, listing the ones that exist; nothing here ever creates a tag.'
        ),
    search_now: z
        .boolean()
        .optional()
        .describe('Start searching immediately. Defaults to true, or false with `path`.'),
    path: z
        .string()
        .min(1)
        .optional()
        .describe('An existing folder under a root folder to adopt as it is, files and all. [[lidarr: Not on Lidarr.]]')
});

export function registerAddMedia(server: McpServer, context: WriteContext, adapters: readonly ServiceAdapter[]): void {
    registerWriteTool(server, context, {
        name: 'add_media',
        title: 'Add a film, series, site, artist or book',
        description:
            'Adds {{or: radarr=a film to Radarr; sonarr=a series to Sonarr; whisparr=a site to Whisparr; lidarr=an artist to Lidarr; shelfmark=a book to Shelfmark}}, and by default starts a search. [[shelfmark: A book (the search row `id`) queues its most-downloaded file; none on offer fails.]] [[seerr: For a Seerr request that goes through approval, use request_media.]] Ids come from search_media `source: "discover"`, under `ids`[[radarr|sonarr|whisparr|lidarr: : {{and: radarr=TMDB for Radarr; sonarr=TVDB for Sonarr; whisparr=TVDB for Whisparr (its own scene id in that field); lidarr=MusicBrainz for Lidarr}}]]. With more than one quality profile or root folder, name one: call without them and the preview refuses with the list. [[lidarr: Lidarr takes `monitor` (which albums), `monitor_new_items` and `metadata_profile`; `monitor: "none"` needs `monitored: false` with it, and its search on add covers only monitored, released albums.]] An option sent to the wrong service is refused, not dropped. Previews first; confirm to add. Field reference: arr://docs/add_media.',
        inputSchema: AddMediaInput,
        // The resolved instance id, not the bare type: permissions are granted per
        // instance, so checking `radarr` against a config that only grants
        // `radarr/hd` would deny a permitted write, or worse, the reverse.
        target: { adapters, to: TARGET },
        operation: 'add_media',
        tier: 'safe',
        crossCheck: 'acquire',

        async plan({
            service,
            
            external_id,
            quality_profile,
            root_folder,
            monitored,
            search_now,
            monitor,
            minimum_availability,
            series_type,
            tags,
            monitor_new_items,
            metadata_profile,
            path
        }, adapter): Promise<WritePlan> {
            if (!hasMediaAdd(adapter)) {
                refuseBookOptions(service, {
                    quality_profile,
                    root_folder,
                    monitor,
                    minimum_availability,
                    series_type,
                    tags,
                    monitor_new_items,
                    metadata_profile,
                    path,
                    monitored: monitored ? undefined : false,
                    search_now: search_now === false ? search_now : undefined
                });
                const top = await topRelease(adapter, service, { id: external_id });
                const target = `${adapter.id}:${top.guid}`;
                // A queue row's id is the hash of the release's source_id, which is the
                // hash part of the guid (`guidOf`, `#queueItem` in shelfmark.ts).
                const hash = top.guid.slice(top.guid.indexOf(':') + 1);
                let queueChecked = false;
                if (hasQueue(adapter)) {
                    try {
                        const queued = (await adapter.getQueue()).find(row => row.id === hash);
                        queueChecked = true;
                        if (queued !== undefined) {
                            // An `error` row is a failed download still in the queue: queueing the
                            // same release again would not help. Shelfmark's own check says whether
                            // retry_download can take this id; only its refusal means it cannot.
                            const retry =
                                queued.status !== 'error' || !hasRetry(adapter)
                                    ? 'unchecked'
                                    : await adapter.findRetryTarget(queued.id, { hasPassword: false }).then(
                                          () => 'yes' as const,
                                          (err: unknown) => (err instanceof ServiceError && err.detail === NOT_RETRYABLE ? ('no' as const) : ('unchecked' as const))
                                      );
                            const failed = `${top.title} already failed in ${service}'s queue.`;
                            const summary =
                                queued.status !== 'error'
                                    ? `${top.title} is already queued in ${service}.`
                                    : retry === 'yes'
                                      ? `${failed} To try it again, use retry_download with id "${queued.id}".`
                                      : retry === 'no'
                                        ? `${top.title} already failed in ${service}'s queue and cannot be retried. Pick another file with get_releases and grab_release.`
                                        : `${failed} Whether it can be retried was not checked; retry_download with id "${queued.id}" may run it again.`;
                            return {
                                target,
                                summary,
                                effects: [],
                                noop: true
                            };
                        }
                    } catch (err) {
                        logger.warn({ service: adapter.id, err }, 'could not read the queue to check for a duplicate book');
                    }
                }
                const bookdrop = adapters.some(a => a.type === 'grimmory')
                    ? "Shelfmark writes the file to its destination folder. When that is Grimmory's Bookdrop, the book waits in get_queue until import_download approves it."
                    : 'Shelfmark writes the file to its destination folder.';
                return {
                    target,
                    summary: `Queue the book ${top.title} on ${service} from ${top.indexer}, the most-downloaded release on offer.`,
                    effects: [
                        `Sends this release to ${service}'s download client.${top.downloads === undefined ? ' No release on offer has a download count, so this is simply the first listed.' : ` It has ${top.downloads} downloads.`}`,
                        bookdrop,
                        queueChecked
                            ? "Shelfmark's queue has no copy of this release yet."
                            : "Could not read Shelfmark's queue, so a copy already queued was not checked for.",
                        "Grimmory's library is not checked for this book.",
                        'To take a different file, pick one from get_releases and pass its `guid` and `indexer_id` to grab_release.',
                        'The download appears in get_queue and can be removed again with remove_queue_item.'
                    ],
                    args: { guid: top.guid, indexerId: top.indexerId }
                };
            }
            const lidarr = adapter.type === 'lidarr';
            if (lidarr && path !== undefined) {
                throw new ServiceError('NotFound', service, 'path is not a Lidarr option', {
                    remedy: "Lidarr finds an artist's existing folder through its own Library Import. Drop `path`."
                });
            }
            const searchNow = search_now ?? path === undefined;
            refuseMalformedId(service, adapter.type, external_id);

            const sonarr = adapter.type === 'sonarr';
            if (!lidarr && metadata_profile !== undefined) {
                throw new ServiceError('NotFound', service, 'metadata_profile is a Lidarr option', {
                    remedy: 'Only an artist has a metadata profile. Drop it.'
                });
            }
            if (!lidarr && !sonarr && monitor_new_items !== undefined) {
                throw new ServiceError('NotFound', service, 'monitor_new_items is a Lidarr and Sonarr option', {
                    remedy: 'Only an artist or a series has a rule for what it finds later. Drop it.'
                });
            }
            if (sonarr && monitor_new_items === 'new') {
                throw new ServiceError('NotFound', service, '`new` is a Lidarr rule', {
                    remedy: 'Sonarr takes `all` or `none` for the seasons it finds later.'
                });
            }
            if (lidarr && (monitor === 'firstSeason' || monitor === 'lastSeason' || monitor === 'pilot')) {
                throw new ServiceError('NotFound', service, `${monitor} is not a Lidarr monitor mode`, {
                    remedy: 'An artist has albums, not seasons. Use `first` or `latest` for one album, or `all`, `future`, `missing`, `existing` or `none`.'
                });
            }
            if ((adapter.type === 'sonarr' || adapter.type === 'whisparr') && (monitor === 'first' || monitor === 'latest')) {
                throw new ServiceError('NotFound', service, `${monitor} is a Lidarr monitor mode`, {
                    remedy: 'For a series, use `firstSeason` or `lastSeason`.'
                });
            }
            // Lidarr's add turns `none` into an unmonitored artist as well as
            // unmonitored albums (`AddArtistService`), against the default
            // `monitored: true`. Refused rather than quietly overriding it, so
            // the caller says which they meant.
            if (lidarr && monitor === 'none' && monitored) {
                throw new ServiceError('NotFound', service, 'monitor "none" also adds the artist itself unmonitored on Lidarr', {
                    remedy: 'Pass `monitored: false` with it to add the artist unmonitored. To keep the artist monitored with no album yet, pick `future`, or set albums later with set_monitoring.'
                });
            }

            // Refused before any call, and named for the service that *does*
            // have the option: silently dropping one would add the series with
            // every season monitored against an explicit "future only".
            if (monitor !== undefined && adapter.type !== 'sonarr' && adapter.type !== 'whisparr' && !lidarr) {
                throw new ServiceError('NotFound', service, 'monitor mode is a Sonarr, Whisparr or Lidarr option', {
                    remedy: 'Films have no seasons. Use `monitored` on Radarr, and `minimum_availability` for how early it may grab.'
                });
            }
            // Whisparr's own MonitorTypes enum has no `pilot` (a site has no
            // pilot scene) and calls Sonarr's `lastSeason` `latestSeason`. The
            // rename is handled below, invisibly; `pilot` has no equivalent.
            if (monitor === 'pilot' && adapter.type === 'whisparr') {
                throw new ServiceError('NotFound', service, 'pilot is a Sonarr-only monitor mode', {
                    remedy: 'A site has no pilot scene. Use `firstSeason`, `future`, `all`, `missing`, `existing`, `lastSeason` or `none`.'
                });
            }
            if (series_type !== undefined && adapter.type !== 'sonarr') {
                throw new ServiceError('NotFound', service, 'series_type is a Sonarr option', {
                    remedy: lidarr ? 'An artist has no numbering scheme. Drop it.' : 'Films have no numbering scheme. Drop it.'
                });
            }
            if (minimum_availability !== undefined && adapter.type !== 'radarr') {
                throw new ServiceError('NotFound', service, 'minimum_availability is a Radarr option', {
                    remedy: lidarr
                        ? 'Lidarr has no availability threshold. Use `monitor` to choose which albums.'
                        : 'Sonarr grabs each episode as it airs. Use `monitor` to choose which seasons.'
                });
            }

            // Together: they are independent, and a preview that takes three
            // sequential round trips on a LAN service is needlessly slow. The
            // tag list is only read when tags were asked for; an add that
            // wants none must not fail because the tag endpoint is down.
            const [candidate, profiles, folders, knownTags, metadataProfiles] = await Promise.all([
                adapter.lookupForAdd(external_id),
                adapter.listQualityProfiles(),
                adapter.listRootFolders(),
                tags === undefined ? Promise.resolve([]) : adapter.listTags(),
                hasMetadataProfiles(adapter) ? adapter.listMetadataProfiles() : Promise.resolve(undefined)
            ]);

            const label = titled(candidate.title, candidate.year);

            // Already there is a no-op, not a failure, and adding again would
            // be a duplicate entry rather than a second copy of the film.
            if (candidate.existingId !== undefined) {
                return {
                    target: `${adapter.id}:${external_id}`,
                    summary: `${label} is already in ${adapter.id} (id ${candidate.existingId}).`,
                    effects: [],
                    noop: true
                };
            }

            const profile = chooseOne(
                profiles,
                quality_profile,
                PROFILE_MATCH,
                p => `${p.display} (id ${p.id})`,
                'quality profile',
                service
            );

            const folder =
                path !== undefined && root_folder === undefined
                    ? rootOf(folders, path, service)
                    : chooseOne(folders, root_folder, FOLDER_MATCH, f => `${f.display} (${freeSpace(f)})`, 'root folder', service);
            // A named root must hold the folder: Radarr and Sonarr keep both, and they would disagree.
            if (path !== undefined && root_folder !== undefined) rootOf([folder], path, service);

            // Lidarr's second profile; see `chooseMetadataProfile`.
            const folderDefault = metadataProfiles?.find(p => p.id === folder.defaultMetadataProfileId);
            const metadataProfile =
                metadataProfiles === undefined ? undefined : chooseMetadataProfile(metadataProfiles, metadata_profile, folderDefault, service);

            // Resolved one at a time so the refusal names the label that
            // missed, not the whole list.
            const resolvedTags = (tags ?? []).map(requested =>
                chooseOne(knownTags, requested, TAG_MATCH, t => `${t.display} (id ${t.id})`, 'tag', service)
            );

            // The None profile gives the artist no albums, so no line about
            // which albums are monitored applies.
            const noAlbums = metadataProfile?.name === NO_ALBUMS_PROFILE;
            const effects = [
                `Adds ${label} to ${service} under ${folder.display} (${freeSpace(folder)}), quality profile ${profile.display} (id ${profile.id})${metadataProfileNote(
                    metadataProfile,
                    metadata_profile === undefined && folderDefault !== undefined
                )}.`,
                monitoredEffect(monitored, lidarr, noAlbums)
            ];
            if (path !== undefined) {
                effects.push(`Adopts the existing folder ${JSON.stringify(path)} rather than creating one; ${service} scans it on add, so files already there count as on disk.`);
                const doubt = folderDoubt(path, candidate, adapter.type, external_id);
                if (doubt !== undefined) effects.push(`Check first: ${doubt}. A folder holding another title would be adopted as this one.`);
            }

            if (monitor !== undefined && lidarr) {
                // `future` with `none` gets one line from `lidarrInitialAlbums` instead.
                if (!noAlbums && lidarrInitialAlbums(monitor, monitor_new_items) !== NOTHING_MONITORED_FUTURE) {
                    effects.push(
                        monitor === 'none'
                            ? 'Monitors no album.'
                            : `Monitors the "${monitor}" set of albums; ${service} works out which those are.`
                    );
                }
            } else if (monitor !== undefined) {
                effects.push(
                    monitor === 'none'
                        ? 'Monitors no season, so nothing is grabbed until a season or episode is monitored.'
                        : `Monitors the "${monitor}" set of seasons; ${service} works out which those are.`
                );
            }
            // Said under `None` too: albums from a later profile change are flagged by this rule.
            if (monitor_new_items !== undefined) {
                effects.push(
                    sonarr
                        ? monitor_new_items === 'none'
                            ? 'Seasons Sonarr finds later start unmonitored.'
                            : 'Seasons Sonarr finds later are monitored.'
                        : noAlbums
                          ? NO_ALBUMS_NEW_ITEMS_EFFECT[monitor_new_items]
                          : NEW_ITEMS_EFFECT[monitor_new_items]
                );
            }
            const initial = lidarr && !noAlbums ? lidarrInitialAlbums(monitor, monitor_new_items) : undefined;
            if (initial !== undefined) effects.push(initial);
            if (minimum_availability !== undefined) {
                effects.push(`Will not grab anything until the film is ${minimum_availability}.`);
            }
            if (series_type !== undefined) effects.push(`Treats it as ${series_type} numbering.`);
            if (resolvedTags.length > 0) {
                effects.push(`Tags it ${resolvedTags.map(t => t.display).join(', ')}.`);
            }

            effects.push(searchEffect(searchNow, lidarr, monitored, monitor, monitor_new_items, noAlbums));

            // Whisparr's wire name for "lastSeason" is "latestSeason"; the rename
            // happens here, at the boundary, so the tool keeps one vocabulary and
            // the token still commits to the value that will actually be posted.
            const wireMonitor =
                monitor === 'lastSeason' && adapter.type === 'whisparr' ? 'latestSeason' : monitor;

            return {
                target: `${adapter.id}:${external_id}`,
                summary: `Add ${label} to ${adapter.id}.`,
                effects,
                // The resolved profile and folder, not the strings asked for:
                // the token must commit to what will actually happen, so a
                // preview showing "1080p into /movies" cannot be confirmed
                // into "4K into /media2".
                args: {
                    service,
                    externalId: external_id,
                    qualityProfileId: profile.id,
                    rootFolderPath: folder.path,
                    monitored,
                    searchNow,
                    ...(path === undefined ? {} : { path }),
                    ...(wireMonitor === undefined ? {} : { monitor: wireMonitor }),
                    ...(minimum_availability === undefined ? {} : { minimumAvailability: minimum_availability }),
                    ...(series_type === undefined ? {} : { seriesType: series_type }),
                    ...(resolvedTags.length === 0 ? {} : { tagIds: resolvedTags.map(t => t.id) }),
                    ...(metadataProfile === undefined ? {} : { metadataProfileId: metadataProfile.id }),
                    ...(monitor_new_items === undefined ? {} : { monitorNewItems: monitor_new_items })
                },
                // Every id the lookup reported, so a series can reach Reclaimerr
                // by TMDB as well as Seerr by TVDB. Not in the library yet, so
                // there is no *arr id to match a queue row on.
                ...arrSubject(adapter, { label, ids: candidate.ids })
            };
        },

        async apply(plan, _args, adapter) {
            if (!hasMediaAdd(adapter)) {
                const { guid, indexerId } = plan.args as { guid: string; indexerId: number };
                await adapter.grabRelease({ guid, indexerId });
                return { grabbed: `${adapter.id}:${guid}` };
            }
            const a = plan.args as {
                externalId: string;
                qualityProfileId: number;
                rootFolderPath: string;
                monitored: boolean;
                searchNow: boolean;
                monitor?: string;
                minimumAvailability?: string;
                seriesType?: string;
                tagIds?: number[];
                metadataProfileId?: number;
                monitorNewItems?: ArtistMonitorNewItems;
                path?: string;
            };

            // Taken from the plan rather than re-resolved from the arguments:
            // re-running `chooseOne` here could land on a different profile if
            // one was added in between, and the token guaranteed the one that
            // was previewed.
            return adapter.addMedia({
                externalId: a.externalId,
                qualityProfileId: a.qualityProfileId,
                rootFolderPath: a.rootFolderPath,
                monitored: a.monitored,
                searchNow: a.searchNow,
                ...(a.monitor === undefined ? {} : { monitor: a.monitor }),
                ...(a.minimumAvailability === undefined ? {} : { minimumAvailability: a.minimumAvailability }),
                ...(a.seriesType === undefined ? {} : { seriesType: a.seriesType }),
                ...(a.tagIds === undefined ? {} : { tagIds: a.tagIds }),
                ...(a.metadataProfileId === undefined ? {} : { metadataProfileId: a.metadataProfileId }),
                ...(a.monitorNewItems === undefined ? {} : { monitorNewItems: a.monitorNewItems }),
                ...(a.path === undefined ? {} : { path: a.path })
            });
        }
    });
}
