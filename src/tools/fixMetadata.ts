import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { findMismatches, findMovieMismatches, pinnedToProvider, type EpisodeRecord, type Mismatch, type MovieRecord } from '../core/episodeMismatch.ts';
import { ServiceError } from '../core/errors.ts';
import { fenceText } from '../core/fence.ts';
import { unfenced } from '../core/titleMatch.ts';
import type { IdentityResolver } from '../core/identity.ts';
import {
    hasMetadataInspect,
    hasMetadataRepair,
    type MetadataInspectCapable,
    type MetadataRepairCapable,
    type ServiceAdapter
} from '../services/types.ts';
import { buildResolvedMediaDetails } from './getMediaDetails.ts';
import type { LibraryLoader } from './library.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';

/**
 * "The episode titles on these files are wrong" — the repair `trigger_scan`
 * was never for. A scan asks whether a file is on disk; this asks whether the
 * metadata bolted to that file describes it, and replaces it when it does not.
 *
 * `destructive` tier, and not as a formality: the repair sets
 * `replaceAllMetadata=true`, which overwrites whatever the server held with no
 * way back. Anything hand-corrected in Jellyfin is lost with the wrong data.
 * That is why the preview leads with evidence — the mismatching files
 * themselves — rather than a count alone.
 */

/**
 * Jellyfin-only, exactly as `set_watched` is, and the remedy says which of the
 * two situations the reader is in. Plex is read-only in arr-mcp, so a Plex
 * stack can reach the detect half through the same reads and never the
 * repair — see #203.
 */
const metadataRemedy = (adapters: readonly ServiceAdapter[]): string =>
    adapters.some(a => a.type === 'plex')
        ? 'fix_metadata repairs through Jellyfin. Plex is read-only in arr-mcp, and jellyfin/plex cannot both be configured, so this needs the services.plex block replaced with services.jellyfin.'
        : 'Metadata repair lives in the media server. Add a services.jellyfin block to config.yaml and restart.';

const jellyfinAdapter = (
    adapters: readonly ServiceAdapter[]
): ServiceAdapter & MetadataInspectCapable & MetadataRepairCapable => {
    const adapter = adapters.find(a => a.type === 'jellyfin');
    if (adapter === undefined || !hasMetadataInspect(adapter) || !hasMetadataRepair(adapter)) {
        throw new ServiceError('NotFound', 'jellyfin', 'jellyfin is not configured', { remedy: metadataRemedy(adapters) });
    }
    return adapter;
};

const requireIdentity = (adapters: readonly ServiceAdapter[], identity: IdentityResolver | undefined): IdentityResolver => {
    if (identity === undefined) {
        throw new ServiceError('NotFound', 'jellyfin', 'jellyfin is not configured', { remedy: metadataRemedy(adapters) });
    }
    return identity;
};

/** How many examples ride along in the preview. Enough to recognise the
 *  pattern, few enough to read before confirming. */
const EXAMPLE_LIMIT = 5;

const describe = (m: Mismatch): string => {
    // Unfenced before the split and fenced again after, rather than split as
    // it arrives: the closing marker `<</untrusted>>` contains a slash, so
    // splitting the fenced string on path separators returns the tail of the
    // marker instead of the filename. Re-fencing keeps the guarantee that
    // server-supplied text is labelled wherever it is printed.
    const raw = unfenced(m.path);
    const file = fenceText(raw.split(/[/\\]/).at(-1) ?? raw, { service: 'jellyfin', field: 'Path' });
    const server =
        m.serverSeason !== undefined && m.serverEpisode !== undefined
            ? `S${m.serverSeason}E${m.serverEpisode} ${m.serverTitle}`
            : m.serverYear === undefined
              ? m.serverTitle
              : `${m.serverTitle} (${m.serverYear})`;
    return `${file} → ${server} (${m.reasons.join(' + ')})`;
};

type Resolved = {
    itemId: string;
    title: string;
    kind: 'movie' | 'series';
    tvdbId?: number;
    tmdbId?: number;
    /** No Radarr or Sonarr manages this, so any provider id on it is the media
     *  server's own — possibly the wrong one that caused the mismatch. */
    unmanaged: boolean;
};

/**
 * Which provider id the repair will actually pin, decided once.
 *
 * TMDB for a film because Radarr is built on it, TVDB for a series because
 * Sonarr is, with the other as a fallback. The summary, the "not pinned"
 * warning and the confirmation token all read this, so none of the three can
 * describe a different id from the one `apply` sends.
 */
const pinnedProvider = (
    item: Resolved
): { label: string; id?: { tvdbId?: number; tmdbId?: number } } => {
    const order = item.kind === 'movie' ? ([['TMDB', 'tmdbId'], ['TVDB', 'tvdbId']] as const) : ([['TVDB', 'tvdbId'], ['TMDB', 'tmdbId']] as const);

    for (const [label, key] of order) {
        const value = item[key];
        if (value !== undefined) return { label: `${label} ${value}`, id: { [key]: value } };
    }
    return { label: 'no pinned provider id' };
};

/**
 * Title to Jellyfin item, through the same library index `get_media_details`
 * uses — so a title that resolves there resolves the same way here.
 *
 * Films and series both, but on different evidence. A series is judged on
 * episode numbering and episode filenames; a film has neither, so it is judged
 * on its **year** and its title. The year is the film's confident signal for
 * the same reason numbering is the series' one: a film file names its year
 * almost universally, and a year that disagrees means the server matched a
 * different film rather than the same one worded differently.
 */
async function resolve(loader: LibraryLoader, query: string): Promise<Resolved> {
    const best = await buildResolvedMediaDetails(loader, query);

    const itemId = best.playback?.itemId;
    if (itemId === undefined) {
        throw new ServiceError('NotFound', 'jellyfin', `"${best.title}" is not in Jellyfin`, {
            remedy:
                'fix_metadata repairs what the media server holds. This title is managed by an *arr but the media server has no item for it — run trigger_scan first, then try again.'
        });
    }

    return {
        itemId,
        title: best.title,
        kind: best.kind,
        unmanaged: best.acquisition === undefined,
        ...(best.ids.tvdb === undefined ? {} : { tvdbId: best.ids.tvdb }),
        ...(best.ids.tmdb === undefined ? {} : { tmdbId: best.ids.tmdb })
    };
}

export function registerFixMetadata(
    server: McpServer,
    context: WriteContext,
    adapters: readonly ServiceAdapter[],
    loader: LibraryLoader,
    identity: IdentityResolver | undefined
): void {
    registerWriteTool(server, context, {
        name: 'fix_metadata',
        title: 'Repair wrong metadata',
        description:
            'Finds and repairs episodes whose Jellyfin metadata does not describe the file on disk — the case where a file named `Episode 101 …` is shown as S1E1 with a completely different title. This is not `trigger_scan`: a scan checks whether a file is on disk and never replaces a wrong title. Give a film or series title as `query`. The preview lists the mismatching files themselves, split into `numbering` findings (the season or episode number the path states disagrees with the server, high confidence) and `title` findings (the filename and the title share no words, advisory — a romanised filename against an English title is a legitimate disagreement). A film is judged on its **year** and title rather than on episode numbering: a film file names its year almost universally, and a year that disagrees means the server matched a different film rather than the same one worded differently. **Destructive**: the repair re-identifies the item against TVDB for a series or TMDB for a film and refreshes with `replaceAllMetadata`, which overwrites everything the server held, including anything corrected by hand. There is no undo. It also has a known limit, stated in the preview rather than discovered afterwards: a refresh does not re-derive an episode\'s season, number or title from its file, so episodes that were matched to a specific provider episode will not move. When the preview says that, the repair that works is `trigger_scan` with `action: "rename"` on the Sonarr series followed by a Jellyfin rescan — not this tool. **The repair is slow**: Jellyfin holds the identify request open while it talks to the provider and rebuilds the item, and a live run on a 69-episode series took longer than a normal read timeout allows. A long wait is not a hang — do not retry, which starts a second full rematch. Previews by default — call again with the returned `confirm` token to apply it.',
        inputSchema: z.object({
            query: z.string().min(1).describe('A film or series title. Resolved through the library index, the same way get_media_details resolves one.'),
            user: z
                .string()
                .optional()
                .describe(
                    'Whose view of the library to read the episodes through. Defaults to services.jellyfin.default_user; naming anyone else needs services.jellyfin.allow_other_users.'
                )
        }),
        service: 'jellyfin',
        operation: 'fix_metadata',
        tier: 'destructive',

        async plan({ query, user }): Promise<WritePlan> {
            const adapter = jellyfinAdapter(adapters);
            const viewer = await requireIdentity(adapters, identity).resolve(user);
            const series = await resolve(loader, query);

            /**
             * A film is read out of the whole-library film list rather than by
             * id: the media server has no per-title episode endpoint to stand
             * in for one, and this read is a single request either way.
             */
            let parts: readonly (EpisodeRecord | MovieRecord)[];
            let mismatches: Mismatch[];

            if (series.kind === 'movie') {
                const films = await adapter.readMovieMetadata(viewer, series.itemId);
                parts = films;
                mismatches = findMovieMismatches(films);
            } else {
                const episodes = await adapter.readEpisodeMetadata(viewer, series.itemId);
                parts = episodes;
                mismatches = findMismatches(episodes);
            }
            const target = `jellyfin:${series.itemId}`;
            const unit = series.kind === 'movie' ? 'file' : 'episodes';

            const comparable = parts.filter(e => e.path !== undefined).length;
            if (comparable === 0) {
                // Distinct from "nothing is wrong", and the difference matters:
                // a server that returned no paths was never actually asked the
                // question, and reporting that as a clean bill of health would
                // be a lie in the reassuring direction.
                throw new ServiceError('UpstreamError', 'jellyfin', `Jellyfin returned no file paths for "${series.title}"`, {
                    remedy:
                        'Nothing could be compared, so nothing is claimed. This read needs a token whose user can see file paths — an administrator — and an item whose files are on disk.'
                });
            }

            if (mismatches.length === 0) {
                return {
                    target,
                    summary: `Nothing in ${series.title} disagrees with its files (${comparable} ${unit} checked).`,
                    effects: [],
                    noop: true
                };
            }

            /**
             * The finding that decides whether this write is worth doing at
             * all, and it is stated first because it is the one that can waste
             * someone's time.
             *
             * A refresh re-fetches an episode from the provider id stored *on
             * that episode*. An episode pinned to the wrong id is therefore
             * re-written with the same wrong metadata, and the repair reports
             * success having changed nothing. Verified on Dragon Ball Kai: all
             * 68 mismatching episodes carried their own AniDB/TVDB ids, the
             * repair applied cleanly, and every title came back identical.
             */
            // Films are exempt. An episode pinned to a provider id keeps its
            // scan-time numbering across a refresh, which is what makes the
            // repair pointless there. A film has no such index: its year and
            // title come from the match, and re-identifying re-derives both —
            // so every matched film would otherwise be told, wrongly, that this
            // repair achieves nothing and to rename a Sonarr series.
            const byId = new Map(parts.map(e => [e.id, e]));
            const pinned =
                series.kind === 'movie'
                    ? 0
                    : mismatches.filter(m => {
                          const record = byId.get(m.id);
                          return record !== undefined && pinnedToProvider(record);
                      }).length;

            const numbering = mismatches.filter(m => m.reasons.includes('numbering')).length;
            const titleOnly = mismatches.length - numbering;
            // One decision, used by the summary, the warning and the token
            // binding, so the three cannot disagree about which id is pinned.
            const provider = pinnedProvider(series);

            return {
                target,
                summary:
                    pinned === mismatches.length
                        ? `${series.title} has ${mismatches.length} of ${comparable} episodes disagreeing with their files, but every one of them was matched to a specific provider episode — a refresh will not move those, and this repair is expected to change nothing.`
                        : `Re-identify ${series.title} against ${provider.label} and replace all of its metadata: ${mismatches.length} of ${comparable} ${unit} disagree with their files.`,
                effects: [
                    ...(pinned === 0
                        ? []
                        : [
                              pinned === mismatches.length
                                  ? `EXPECTED TO ACHIEVE NOTHING. All ${pinned} mismatching episodes were matched to a specific provider episode, and a refresh does not re-derive an episode's season, number or title from its file — those are stored on the item from the original scan. Measured on a real library in this exact state: a full refresh changed nothing, and so did clearing an episode's provider ids and refreshing it again. The repair that does work is upstream — trigger_scan with action "rename" on the Sonarr series to give the files proper SxxExx names, then trigger_scan on Jellyfin to rescan them.`
                                  : `${pinned} of the ${mismatches.length} mismatching episodes were matched to a specific provider episode, and a refresh will not move those — an episode's numbers and title are stored on the item from the original scan, not re-derived from the file. For those, trigger_scan with action "rename" on the Sonarr series and then a Jellyfin rescan is the repair that works.`
                          ]),
                    'Replaces every metadata field on the series and its episodes. Anything corrected by hand in Jellyfin is overwritten, and the previous values are not recoverable.',
                    ...(provider.id === undefined
                        ? [
                              'No provider id is known for this title, so the identity is not pinned before the refresh — the server may re-match it the same wrong way. Fix it in Radarr or Sonarr first.'
                          ]
                        : []),
                    // m3: an id that came only from the media server is not
                    // independent evidence — it may be the wrong id that caused
                    // this. Say so rather than presenting it as a fix.
                    ...(provider.id !== undefined && series.unmanaged
                        ? [
                              `${provider.label} is the media server's own id for this title, and no Radarr or Sonarr manages it — so re-identifying may pin exactly the id that is already wrong.`
                          ]
                        : []),
                    `${numbering} episode${numbering === 1 ? '' : 's'} where the path's own season/episode number disagrees with the server.`,
                    `${titleOnly} where only the title text disagrees — the weaker signal, and legitimate for a romanised or alternate-language filename.`,
                    ...mismatches.slice(0, EXAMPLE_LIMIT).map(describe),
                    ...(mismatches.length > EXAMPLE_LIMIT ? [`…and ${mismatches.length - EXAMPLE_LIMIT} more.`] : [])
                ],
                // The count is bound into the token deliberately: if the library
                // changed between preview and confirm, the evidence the person
                // agreed to no longer describes what would happen, and a fresh
                // preview is the right outcome.
                // No token for a write this predicts will do nothing. Issuing
                // one asks a person to confirm a destructive, irreversible
                // operation whose own preview says it achieves nothing, which
                // is how confirming becomes reflexive.
                ...(pinned > 0 && pinned === mismatches.length && numbering > 0 ? { noop: true } : {}),
                args: {
                    itemId: series.itemId,
                    mismatches: mismatches.length,
                    // Bound into the token as well as the count: a confirmation
                    // for a preview that unpinned nothing must not authorise one
                    // that unpins sixty-eight episodes.
                    pinned,
                    kind: series.kind,
                    // The id `apply` will actually pin, not just the series one:
                    // a film pins TMDB, and binding only TVDB left a change to
                    // the film's merged TMDB id invisible to the token.
                    ...(provider.id === undefined ? {} : { providerId: provider.id })
                }
            };
        },

        async apply(plan, { user }) {
            const adapter = jellyfinAdapter(adapters);
            const viewer = await requireIdentity(adapters, identity).resolve(user);

            // From the plan the token was verified against, not a second
            // resolve. Re-resolving would let a concurrent write that
            // invalidated the library index land this repair on a different
            // item than the one the confirmation names.
            const bound = plan.args as { itemId: string; kind: 'movie' | 'series'; providerId?: { tvdbId?: number; tmdbId?: number } };
            const series = { itemId: bound.itemId, kind: bound.kind, title: plan.summary };

            const read = async (): Promise<Mismatch[]> =>
                series.kind === 'movie'
                    ? findMovieMismatches(await adapter.readMovieMetadata(viewer, series.itemId))
                    : findMismatches(await adapter.readEpisodeMetadata(viewer, series.itemId));

            const before = await read();

            // Exactly the id the preview named and the token bound.
            await adapter.repairMetadata(series.itemId, bound.providerId ?? {});

            // Jellyfin refreshes asynchronously, so this re-read is a snapshot
            // taken while the work is very likely still running. It is reported
            // as exactly that — a non-zero `remaining` here is not evidence the
            // repair failed, and calling it one would be the reassuring lie in
            // reverse.
            const after = await read();

            /**
             * The write succeeding and the problem being fixed are two different
             * facts, and this tool used to report only the first. A live run
             * returned `applied: true` having changed nothing at all, which is
             * the reassuring lie every other part of this file is written to
             * avoid — so the outcome is stated in its own words here.
             *
             * `unchanged` is not the same as failure: Jellyfin refreshes in the
             * background, so an identical count immediately afterwards may mean
             * "not finished yet" or may mean "did nothing". Both are reported as
             * unverified rather than one being guessed at.
             */
            return {
                mismatchesBefore: before.length,
                mismatchesAfter: after.length,
                verified: after.length < before.length,
                note:
                    after.length < before.length
                        ? `Repaired: ${before.length - after.length} of ${before.length} mismatches are gone. Jellyfin may still be refreshing, so the final count can improve further.`
                        : `NOT VERIFIED: the calls succeeded but ${after.length} mismatches remain, the same as before. Jellyfin refreshes in the background, so this may be too early — re-run with dry_run in a minute. If the count is still identical then a refresh cannot fix this library: an episode's numbers and title are stored on the item from the original scan, not re-derived from the file. The repair that works is trigger_scan with action "rename" on the Sonarr series, then trigger_scan on Jellyfin.`
            };
        }
    });
}
