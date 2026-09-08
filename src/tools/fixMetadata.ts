import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { findMismatches, pinnedToProvider, type Mismatch } from '../core/episodeMismatch.ts';
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
        m.serverSeason === undefined || m.serverEpisode === undefined
            ? m.serverTitle
            : `S${m.serverSeason}E${m.serverEpisode} ${m.serverTitle}`;
    return `${file} → ${server} (${m.reasons.join(' + ')})`;
};

type Resolved = {
    itemId: string;
    title: string;
    tvdbId?: number;
    tmdbId?: number;
};

/**
 * Title to Jellyfin item, through the same library index `get_media_details`
 * uses — so a title that resolves there resolves the same way here.
 *
 * Series only, and the refusal is deliberate rather than an oversight. The
 * mismatch evidence is built from episode numbering and episode filenames; a
 * film has neither, so a film could only be repaired on no evidence at all.
 * A destructive write with nothing in its preview is worse than a refusal.
 */
async function resolve(loader: LibraryLoader, query: string): Promise<Resolved> {
    const best = await buildResolvedMediaDetails(loader, query);

    if (best.kind !== 'series') {
        throw new ServiceError('NotFound', 'jellyfin', `"${best.title}" is a film, and fix_metadata only repairs series`, {
            remedy:
                'Film repair is not implemented: the mismatch evidence this tool previews comes from episode numbering and episode filenames, which a film has neither of. Re-identify a film in Jellyfin directly.'
        });
    }

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
            'Finds and repairs episodes whose Jellyfin metadata does not describe the file on disk — the case where a file named `Episode 101 …` is shown as S1E1 with a completely different title. This is not `trigger_scan`: a scan checks whether a file is on disk and never replaces a wrong title. Give a series title as `query`. The preview lists the mismatching files themselves, split into `numbering` findings (the season or episode number the path states disagrees with the server, high confidence) and `title` findings (the filename and the title share no words, advisory — a romanised filename against an English title is a legitimate disagreement). Series only: a film carries no episode numbering to compare, so one is refused rather than repaired on no evidence. **Destructive**: the repair re-identifies the series against TVDB and refreshes with `replaceAllMetadata`, which overwrites everything the server held, including anything corrected by hand. There is no undo. It also has a known limit, stated in the preview rather than discovered afterwards: a refresh does not re-derive an episode\'s season, number or title from its file, so episodes that were matched to a specific provider episode will not move. When the preview says that, the repair that works is `trigger_scan` with `action: "rename"` on the Sonarr series followed by a Jellyfin rescan — not this tool. **The repair is slow**: Jellyfin holds the identify request open while it talks to the provider and rebuilds the item, and a live run on a 69-episode series took longer than a normal read timeout allows. A long wait is not a hang — do not retry, which starts a second full rematch. Previews by default — call again with the returned `confirm` token to apply it.',
        inputSchema: z.object({
            query: z.string().min(1).describe('The series title. Resolved through the library index, the same way get_media_details resolves one.'),
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

            const episodes = await adapter.readEpisodeMetadata(viewer, series.itemId);
            const mismatches = findMismatches(episodes);
            const target = `jellyfin:${series.itemId}`;

            const comparable = episodes.filter(e => e.path !== undefined).length;
            if (comparable === 0) {
                // Distinct from "nothing is wrong", and the difference matters:
                // a server that returned no paths was never actually asked the
                // question, and reporting that as a clean bill of health would
                // be a lie in the reassuring direction.
                throw new ServiceError('UpstreamError', 'jellyfin', `Jellyfin returned no file paths for "${series.title}"`, {
                    remedy:
                        'Nothing could be compared, so nothing is claimed. This read needs a token whose user can see file paths — an administrator — and a series whose episodes have files.'
                });
            }

            if (mismatches.length === 0) {
                return {
                    target,
                    summary: `Nothing in ${series.title} disagrees with its files (${comparable} episodes checked).`,
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
            const byId = new Map(episodes.map(e => [e.id, e]));
            const pinned = mismatches.filter(m => {
                const record = byId.get(m.id);
                return record !== undefined && pinnedToProvider(record);
            }).length;

            const numbering = mismatches.filter(m => m.reasons.includes('numbering')).length;
            const titleOnly = mismatches.length - numbering;
            const provider =
                series.tvdbId !== undefined
                    ? `TVDB ${series.tvdbId}`
                    : series.tmdbId !== undefined
                      ? `TMDB ${series.tmdbId}`
                      : 'no pinned provider id';

            return {
                target,
                summary:
                    pinned === mismatches.length
                        ? `${series.title} has ${mismatches.length} of ${comparable} episodes disagreeing with their files, but every one of them was matched to a specific provider episode — a refresh will not move those, and this repair is expected to change nothing.`
                        : `Re-identify ${series.title} against ${provider} and replace all of its metadata: ${mismatches.length} of ${comparable} episodes disagree with their files.`,
                effects: [
                    ...(pinned === 0
                        ? []
                        : [
                              pinned === mismatches.length
                                  ? `EXPECTED TO ACHIEVE NOTHING. All ${pinned} mismatching episodes were matched to a specific provider episode, and a refresh does not re-derive an episode's season, number or title from its file — those are stored on the item from the original scan. Measured on a real library in this exact state: a full refresh changed nothing, and so did clearing an episode's provider ids and refreshing it again. The repair that does work is upstream — trigger_scan with action "rename" on the Sonarr series to give the files proper SxxExx names, then trigger_scan on Jellyfin to rescan them.`
                                  : `${pinned} of the ${mismatches.length} mismatching episodes were matched to a specific provider episode, and a refresh will not move those — an episode's numbers and title are stored on the item from the original scan, not re-derived from the file. For those, trigger_scan with action "rename" on the Sonarr series and then a Jellyfin rescan is the repair that works.`
                          ]),
                    'Replaces every metadata field on the series and its episodes. Anything corrected by hand in Jellyfin is overwritten, and the previous values are not recoverable.',
                    ...(series.tvdbId === undefined
                        ? [
                              'No TVDB id is known for this series, so the identity is not pinned before the refresh — the server may re-match it the same wrong way. Consider fixing the series in Sonarr first.'
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
                args: {
                    itemId: series.itemId,
                    mismatches: mismatches.length,
                    // Bound into the token as well as the count: a confirmation
                    // for a preview that unpinned nothing must not authorise one
                    // that unpins sixty-eight episodes.
                    pinned,
                    ...(series.tvdbId === undefined ? {} : { tvdbId: series.tvdbId })
                }
            };
        },

        async apply(_plan, { query, user }) {
            const adapter = jellyfinAdapter(adapters);
            const viewer = await requireIdentity(adapters, identity).resolve(user);
            const series = await resolve(loader, query);

            const before = findMismatches(await adapter.readEpisodeMetadata(viewer, series.itemId));

            await adapter.repairMetadata(series.itemId, {
                // TVDB first: Sonarr is the source of truth for a series, and
                // its id is the one the file layout was built from.
                ...(series.tvdbId === undefined ? {} : { tvdbId: series.tvdbId }),
                ...(series.tvdbId === undefined && series.tmdbId !== undefined ? { tmdbId: series.tmdbId } : {})
            });

            // Jellyfin refreshes asynchronously, so this re-read is a snapshot
            // taken while the work is very likely still running. It is reported
            // as exactly that — a non-zero `remaining` here is not evidence the
            // repair failed, and calling it one would be the reassuring lie in
            // reverse.
            const after = findMismatches(await adapter.readEpisodeMetadata(viewer, series.itemId));

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
