import { INSTANCE_PARAM_DESCRIPTION, resolveInstance } from './resolveInstance.ts';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceIdSchema, type ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import { hasMediaDetails, hasSearchTrigger, type AlbumSummary, type MediaDetails, type ServiceAdapter } from '../services/types.ts';
import { arrSubject } from './crossChecks.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';

/**
 * The first write, and the shape every later one follows.
 *
 * It takes `service` plus `id` and **not** a title. Every read tool accepts a
 * fuzzy title because the cost of resolving one wrongly is a wrong answer the
 * user can see; for a write the cost is an action against the wrong item. The
 * model is expected to establish identity through `get_media_details` or
 * `get_library` first — which also means the id in the audit trail is one the
 * user could have seen before the write, not one this tool invented.
 */

const findAdapter = (adapters: readonly ServiceAdapter[], service: ServiceId, instance?: string) => {
    const adapter = resolveInstance(adapters, service, instance);
    if (!hasSearchTrigger(adapter)) {
        throw new ServiceError('NotFound', service, `${service} cannot be told to search`, {
            remedy: 'Only radarr, sonarr, whisparr and lidarr support trigger_search.'
        });
    }
    return adapter;
};

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
 * preview gives. And an album missing a track skips the upgrade and cutoff
 * checks (`UpgradeDiskSpecification`, `UpgradeAllowedSpecification`,
 * `CutoffSpecification`), so any quality the profile allows can be grabbed for
 * it, though the import replaces a track on disk only with a better one
 * (`TrackImport/Specifications/UpgradeSpecification`).
 */
const REPLACES =
    'A search may grab an upgrade for them. Where an album is missing a track it can grab any quality the profile allows: that fills the missing tracks, and a track on disk is replaced only by a better one.';

function lidarrEffects(
    label: string,
    details: Pick<MediaDetails, 'albums' | 'albumsTruncated' | 'hasFile'>,
    named: readonly AlbumSummary[],
    byAlbum: boolean
): string[] {
    if (byAlbum) {
        const unmonitored = named.filter(a => !a.monitored).length;
        const withFiles = named.filter(a => a.hasFile === true).length;
        return [
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
    return [coverage, ...(details.hasFile === true ? [`Some of its albums already have tracks. ${REPLACES}`] : [])];
}

export function registerTriggerSearch(
    server: McpServer,
    context: WriteContext,
    adapters: readonly ServiceAdapter[]
): void {
    registerWriteTool(server, context, {
        name: 'trigger_search',
        title: 'Search indexers for a release',
        description:
            'Asks Radarr, Sonarr, Whisparr or Lidarr to go looking for releases for one item it already tracks — the "it never downloaded, try again" action. Takes `service` and `id`, deliberately not a title: take `id` from `acquisition.id` on a get_library or get_media_details record. On Sonarr or Whisparr, give `season` to search one season or `episodes` for specific episode ids; giving both is refused rather than resolved, and neither on Radarr, which has no seasons. On Lidarr, `id` is the artist: give `albums` for specific album ids of that artist (from get_media_details at `detail: "full"`), or omit it to search the artist\'s monitored albums. This queues a search and returns immediately; it does not wait for a release to be found, and finding one is not guaranteed. Previews by default — call again with the returned `confirm` token to actually run it.',
        inputSchema: z.object({
            service: ServiceIdSchema.describe('radarr, sonarr, whisparr or lidarr.'),
            instance: z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION),
            id: z.string().min(1).describe("The item's id within that service, as an integer string."),
            season: z
                .number()
                .int()
                .min(0)
                .optional()
                .describe(
                    'Sonarr and Whisparr only. One season. 0 is specials. Omit for the whole series. On Whisparr a season is a release year, e.g. 2019.'
                ),
            episodes: z
                .array(z.string().min(1))
                .min(1)
                .optional()
                .describe(
                    'Sonarr and Whisparr only. Specific episode ids, as integer strings. Mutually exclusive with `season`.'
                ),
            albums: z
                .array(z.string().min(1))
                .min(1)
                .optional()
                .describe(
                    'Lidarr only. Specific album ids of the artist `id`, as integer strings, from get_media_details at `detail: "full"`. Omit to search the whole artist.'
                )
        }),
        // The permission check follows the argument, so enabling `safe_write`
        // on Radarr does not quietly enable it on Sonarr.
        // The resolved instance id, not the bare type: permissions are granted per
        // instance, so checking `radarr` against a config that only grants
        // `radarr/hd` would deny a permitted write — or worse, the reverse.
        service: ({ service, instance }) => findAdapter(adapters, service, instance).id,
        operation: 'trigger_search',
        tier: 'safe',
        crossCheck: 'acquire',

        async plan({ service, instance, id, season, episodes, albums }): Promise<WritePlan> {
            if (season !== undefined && episodes !== undefined) {
                throw new Error(
                    '`season` and `episodes` were both given. They are different targets — send one. Omit both to search the whole series.'
                );
            }
            if ((season !== undefined || episodes !== undefined) && service === 'lidarr') {
                throw new ServiceError('NotFound', service, 'a Lidarr artist has no seasons or episodes', {
                    remedy: 'Pass `albums` with album ids from get_media_details to search specific albums, or neither to search the whole artist.'
                });
            }
            if ((season !== undefined || episodes !== undefined) && service !== 'sonarr' && service !== 'whisparr') {
                throw new ServiceError('NotFound', service, `${service} has no seasons`, {
                    remedy: 'Season and episode scope apply to sonarr and whisparr only. Films have no seasons — omit season and episodes for radarr.'
                });
            }
            if (albums !== undefined && service !== 'lidarr') {
                throw new ServiceError('NotFound', service, '`albums` is a Lidarr option', {
                    remedy: 'Only a Lidarr artist has albums. Use `season` or `episodes` on sonarr and whisparr, or neither on radarr.'
                });
            }

            const adapter = findAdapter(adapters, service, instance);

            // A read before the write, for two reasons: it fails early and
            // legibly if the id does not exist ("Radarr has no movie 9999"
            // rather than a 404 from a command endpoint), and it puts a real
            // title in the preview — a confirmation prompt that says "search
            // for item 5" is one nobody can meaningfully approve.
            if (!hasMediaDetails(adapter)) {
                throw new ServiceError('NotFound', service, `${service} cannot describe its own items`);
            }
            // A Lidarr artist's albums are read every time: they are what an
            // `albums` list is checked against, and what tells the preview how
            // much of the artist a whole-artist search covers.
            const details = await adapter.getMediaDetails(id, {
                includeEpisodes: episodes !== undefined || service === 'lidarr',
                episodeLimit: 500
            });
            const label = `${details.title}${details.year === undefined ? '' : ` (${details.year})`}`;

            // A season or episode id that does not resolve is not "search
            // nothing interesting" — Sonarr accepts a command matching nothing
            // and reports success, so an unvalidated write here is a search
            // that silently searches for nothing at all.
            if (season !== undefined && details.seasons !== undefined) {
                const known = details.seasons.map(s => s.season);
                if (!known.includes(season)) {
                    throw new ServiceError('NotFound', service, `${label} has no season ${season}`, {
                        remedy: `Seasons on this series: ${known.join(', ')}. Get them from get_media_details.`
                    });
                }
            }
            if (episodes !== undefined) {
                const found = new Set((details.episodes ?? []).map(e => String(e.id)));
                const unresolved = episodes.filter(eid => !found.has(eid));
                if (unresolved.length > 0) {
                    throw new ServiceError(
                        'NotFound',
                        service,
                        `Could not find episode(s) ${unresolved.join(', ')} on ${label}` +
                            (details.episodesTruncated === true
                                ? ' — the episode list was truncated at 500, so they may simply not have been fetched.'
                                : '.'),
                        { remedy: 'Check the episode ids from get_media_details.' }
                    );
                }
            }

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
                                ? ' — the album list was truncated at 500, so they may simply not have been fetched.'
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
                // Not a no-op — an unmonitored item can still be searched, and
                // upstream will happily run the command — but the model should
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
                summary: `Ask ${service} to search for releases for ${scope}.`,
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

        async apply(_plan, { service, instance, id, season, episodes, albums }) {
            return findAdapter(adapters, service, instance).triggerSearch(id, {
                ...(season === undefined ? {} : { season }),
                ...(episodes === undefined ? {} : { episodes }),
                ...(albums === undefined ? {} : { albums })
            });
        }
    });
}
