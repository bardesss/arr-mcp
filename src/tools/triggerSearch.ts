import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceError } from '../core/errors.ts';
import { hasSearchTrigger, type AlbumSummary, type MediaDetails, type ServiceAdapter } from '../services/types.ts';
import { arrSubject } from './crossChecks.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';
import { titled } from '../core/labels.ts';
import { targetInput, serviceTarget } from './serviceTarget.ts';
import { checkScope, describable, EPISODE_LIMIT, refuseBoth } from './itemScope.ts';

/**
 * The first write, and the shape every later one follows.
 *
 * It takes `service` plus `id` and **not** a title. Every read tool accepts a
 * fuzzy title because the cost of resolving one wrongly is a wrong answer the
 * user can see; for a write the cost is an action against the wrong item. The
 * model is expected to establish identity through `get_media_details` or
 * `get_library` first, which also means the id in the audit trail is one the
 * user could have seen before the write, not one this tool invented.
 */

const TARGET = serviceTarget({
    services: ['radarr', 'sonarr', 'whisparr', 'lidarr'],
    can: hasSearchTrigger,
    cannot: 'cannot be told to search'
});

/**
 * What a Lidarr search will grab. `ArtistSearch` asks for the artist's
 * monitored albums only (`ReleaseSearchService.ArtistSearch`), and every
 * release outside them is rejected (`AlbumRequestedSpecification`), so with
 * none monitored it grabs nothing, though it still asks every indexer. A
 * discography release counts as every album it spans (`ParsingService`: all of
 * them when it names no years), so it passes while any of those is monitored.
 * A search skips Lidarr's monitored check (`MonitoredAlbumSpecification`:
 * nothing sets `MonitoredEpisodesOnly`), so a named album is grabbed whether it
 * is monitored or not, the opposite of the caution the Radarr and Sonarr
 * preview gives. That early accept comes before the artist's own flag is read,
 * so an unmonitored artist, whose albums Lidarr leaves out of its automatic
 * searches, is still grabbed for here. And an album missing a track skips the upgrade and cutoff
 * checks (`UpgradeDiskSpecification`, `UpgradeAllowedSpecification`,
 * `CutoffSpecification`), so any quality the profile allows can be grabbed for
 * it, though the import replaces a track on disk only with a better one
 * (`TrackImport/Specifications/UpgradeSpecification`).
 */
const REPLACES =
    'A search may grab an upgrade for them. Where an album is missing a track it can grab any quality the profile allows: that fills the missing tracks, and a track on disk is replaced only by a better one.';

function lidarrEffects(
    label: string,
    details: Pick<MediaDetails, 'albums' | 'albumsTruncated' | 'hasFile' | 'monitored'>,
    named: readonly AlbumSummary[],
    byAlbum: boolean
): string[] {
    const artistFlag =
        details.monitored === false
            ? [
                  `${label} is not monitored in Lidarr, which keeps its albums out of Lidarr's own automatic searches. A search started here skips that check, so the artist's flag does not stop it grabbing.`
              ]
            : [];
    if (byAlbum) {
        const unmonitored = named.filter(a => !a.monitored).length;
        const withFiles = named.filter(a => a.hasFile === true).length;
        return [
            ...artistFlag,
            ...(unmonitored === 0
                ? []
                : [
                      `${unmonitored} of these albums ${unmonitored === 1 ? 'is' : 'are'} not monitored. Lidarr skips its monitored check during a search, so it can still grab ${unmonitored === 1 ? 'it' : 'them'}.`
                  ]),
            ...(withFiles === 0 ? [] : [`${withFiles} of these albums already ${withFiles === 1 ? 'has' : 'have'} tracks. ${REPLACES}`])
        ];
    }
    const known = details.albums ?? [];
    const monitored = known.filter(a => a.monitored).length;
    const truncated = details.albumsTruncated === true;
    const read = truncated ? ` of the first ${known.length} read` : ` of ${known.length}`;
    const among = truncated ? ` among the first ${known.length} read` : '';
    const coverage =
        known.length === 0 && !truncated
            ? `${label} has no albums in Lidarr, so a whole-artist search has nothing to grab. Refresh the artist with trigger_scan, or check its metadata profile, which decides which albums Lidarr adds.`
            : monitored === 0
              ? `None of ${label}'s albums is monitored${among}. A whole-artist search still asks every indexer, but grabs only releases of a monitored album, so it ${truncated ? 'may' : 'will'} grab nothing. Name albums in \`albums\`, or monitor them with set_monitoring first.`
              : `Grabs only releases of its monitored albums: ${monitored}${read}.${
                    monitored < known.length || truncated
                        ? ' A discography release counts as every album it spans, so it can bring unmonitored ones along.'
                        : ''
                }`;
    return [coverage, ...artistFlag, ...(details.hasFile === true ? [`Some of its albums already have tracks. ${REPLACES}`] : [])];
}

const TriggerSearchInput = z.object({
    ...targetInput(TARGET),
    id: z.string().min(1).describe("The item's id within that service, as an integer string."),
    season: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
            '[[sonarr|whisparr: {{and: sonarr=Sonarr; whisparr=Whisparr}} only. One season. 0 is specials. Omit for the whole series.]] [[whisparr: On Whisparr a season is a release year, e.g. 2019.]]'
        ),
    episodes: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe(
            '[[sonarr|whisparr: {{and: sonarr=Sonarr; whisparr=Whisparr}} only. Specific episode ids, as integer strings. Mutually exclusive with `season`.]]'
        ),
    albums: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe(
            '[[lidarr: Lidarr only. Specific album ids of the artist `id`, as integer strings, from get_media_details at `detail: "full"`. Omit to search the whole artist.]]'
        )
});

export function registerTriggerSearch(
    server: McpServer,
    context: WriteContext,
    adapters: readonly ServiceAdapter[]
): void {
    registerWriteTool(server, context, {
        name: 'trigger_search',
        title: 'Search indexers for a release',
        description:
            'Asks {{or: radarr=Radarr; sonarr=Sonarr; whisparr=Whisparr; lidarr=Lidarr}} to go looking for releases for one item it already tracks, the "it never downloaded, try again" action. Takes `service` and `id`, deliberately not a title: take `id` from `acquisition.id` on a get_library or get_media_details record. [[sonarr|whisparr: On {{or: sonarr=Sonarr; whisparr=Whisparr}}, give `season` to search one season or `episodes` for specific episode ids; giving both is refused rather than resolved.]] [[radarr: Radarr has no seasons.]] [[lidarr: On Lidarr, `id` is the artist: give `albums` for specific album ids of that artist (from get_media_details at `detail: "full"`), or omit it to search the artist\'s monitored albums.]] This queues a search and returns immediately; it does not wait for a release to be found, and finding one is not guaranteed. Previews first; confirm to run it.',
        inputSchema: TriggerSearchInput,
        // The permission check follows the argument, so enabling `safe_write`
        // on Radarr does not quietly enable it on Sonarr.
        // The resolved instance id, not the bare type: permissions are granted per
        // instance, so checking `radarr` against a config that only grants
        // `radarr/hd` would deny a permitted write, or worse, the reverse.
        target: { adapters, to: TARGET },
        operation: 'trigger_search',
        tier: 'safe',
        crossCheck: 'acquire',

        async plan({ service, id, season, episodes, albums }, adapter): Promise<WritePlan> {
            refuseBoth(season, episodes, 'Omit both to search the whole series.');
            if ((season !== undefined || episodes !== undefined) && service === 'lidarr') {
                throw new ServiceError('NotFound', service, 'a Lidarr artist has no seasons or episodes', {
                    remedy: 'Pass `albums` with album ids from get_media_details to search specific albums, or neither to search the whole artist.'
                });
            }
            if ((season !== undefined || episodes !== undefined) && service !== 'sonarr' && service !== 'whisparr') {
                throw new ServiceError('NotFound', service, `${service} has no seasons`, {
                    remedy: 'Season and episode scope apply to sonarr and whisparr only. Films have no seasons. Omit season and episodes for radarr.'
                });
            }
            if (albums !== undefined && service !== 'lidarr') {
                throw new ServiceError('NotFound', service, '`albums` is a Lidarr option', {
                    remedy: 'Only a Lidarr artist has albums. Use `season` or `episodes` on sonarr and whisparr, or neither on radarr.'
                });
            }

            // A read before the write, for two reasons: it fails early and
            // legibly if the id does not exist ("Radarr has no movie 9999"
            // rather than a 404 from a command endpoint), and it puts a real
            // title in the preview; a confirmation prompt that says "search
            // for item 5" is one nobody can meaningfully approve.
            // A Lidarr artist's albums are read every time: they are what an
            // `albums` list is checked against, and what tells the preview how
            // much of the artist a whole-artist search covers.
            const details = await describable(adapter, service).getMediaDetails(id, {
                includeEpisodes: episodes !== undefined || service === 'lidarr',
                episodeLimit: EPISODE_LIMIT
            });
            const label = titled(details.title, details.year);

            checkScope(details, label, service, { season, episodes });

            const known = details.albums ?? [];
            const named = albums === undefined ? [] : known.filter(a => albums.includes(a.id));
            if (albums !== undefined) {
                const found = new Set(known.map(a => a.id));
                const unresolved = albums.filter(aid => !found.has(aid));
                if (unresolved.length > 0) {
                    throw new ServiceError(
                        'NotFound',
                        service,
                        `Could not find album(s) ${unresolved.join(', ')} on ${label}` +
                            (details.albumsTruncated === true
                                ? '. The album list was truncated at 500, so they may simply not have been fetched.'
                                : '.'),
                        { remedy: 'Check the album ids from get_media_details on this artist, at detail: "full".' }
                    );
                }
            }

            const scope =
                episodes !== undefined
                    ? `${episodes.length} episode(s) of ${label}`
                    : season !== undefined
                      ? `season ${season} of ${label}`
                      : albums !== undefined
                        ? `${new Set(albums).size} album(s) of ${label}`
                        : label;
            const scopeKind =
                episodes !== undefined
                    ? 'episode'
                    : season !== undefined
                      ? 'season'
                      : albums !== undefined
                        ? 'album'
                        : service === 'radarr'
                          ? 'movie'
                          : service === 'lidarr'
                            ? 'whole-artist'
                            : 'whole-series';

            const effects = [
                `Queues ${scopeKind === 'album' ? 'an' : 'a'} ${scopeKind} search on ${service} for ${scope}.`,
                'May grab and start downloading a release, which will appear in get_queue.'
            ];

            if (service === 'lidarr') {
                effects.push(...lidarrEffects(label, details, named, albums !== undefined));
            } else {
                // Not a no-op; an unmonitored item can still be searched, and
                // upstream will happily run the command, but the model should
                // say so rather than let the user wonder why nothing arrives.
                if (details.monitored === false) {
                    effects.push(
                        `${label} is not monitored on ${service}, so the search may find a release and still not grab it.`
                    );
                }
                if (details.hasFile === true) {
                    effects.push('This item already has a file; a search may replace it with an upgrade.');
                }
            }

            return {
                target: `${adapter.id}:${id}`,
                summary: `Ask ${adapter.id} to search for releases for ${scope}.`,
                effects,
                args: {
                    service,
                    id,
                    ...(season === undefined ? {} : { season }),
                    ...(episodes === undefined ? {} : { episodes }),
                    ...(albums === undefined ? {} : { albums })
                },
                ...arrSubject(adapter, { label, ids: details.ids, acquisition: { service: adapter.id, id } })
            };
        },

        async apply(_plan, { id, season, episodes, albums }, adapter) {
            return adapter.triggerSearch(id, {
                ...(season === undefined ? {} : { season }),
                ...(episodes === undefined ? {} : { episodes }),
                ...(albums === undefined ? {} : { albums })
            });
        }
    });
}
