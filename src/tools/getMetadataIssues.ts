import type { McpServer } from '@modelcontextprotocol/server';
import {
    findMismatches,
    findMovieMismatches,
    movieRemedy,
    pinnedToProvider,
    summariseSeries,
    type Remedy
} from '../core/episodeMismatch.ts';
import { fenceText } from '../core/fence.ts';
import { logger } from '../core/logger.ts';
import type { IdentityResolver } from '../core/identity.ts';
import { unfenced } from '../core/titleMatch.ts';
import {
    DetailSchema,
    LimitSchema,
    OffsetSchema,
    PagedOutputSchema,
    READ_ONLY,
    applyLimit,
    toolInput,
    type DetailLevel
} from '../core/shape.ts';
import { hasMetadataInspect, hasUserLibrary, type ServiceAdapter } from '../services/types.ts';

/**
 * The discovery half of `fix_metadata`.
 *
 * `fix_metadata` only ever looks at a series you already suspect, and the
 * expensive lesson from a real library is that you mostly do not know which to
 * suspect: sweeping 101 series turned up two problems nobody had noticed
 * beside the one that prompted the work.
 *
 * Read-only, and deliberately not folded into `get_library`: this costs one
 * episode read per series, which is far too expensive to ride along on a
 * cached list every caller pays for.
 */

export type MetadataIssue = {
    service: string;
    /** The media server's item id — what `fix_metadata` acts on. */
    itemId: string;
    /** Which kind of item this row is about. Films have no episode numbering,
     *  so their confident signal is the year instead. */
    kind: 'movie' | 'series';
    title: string;
    mismatches: number;
    /**
     * Optional because `detail: "minimal"` drops them, not because they are
     * ever unknown — same contract as `get_subtitles`. `mismatches`, `remedy`
     * and `fix` are the answer and survive every detail level.
     */
    /** How many of the series' episodes had a file to compare at all. */
    compared?: number;
    /** The confident half: the path's own season/episode disagrees. */
    numbering?: number;
    /** The advisory half: the words disagree. */
    titleOnly?: number;
    /** How many mismatching episodes the server had already matched to a
     *  provider episode — the signal that decides `remedy`. */
    pinned?: number;
    remedy: Remedy;
    /** What to actually run. */
    fix: string;
    examples?: string[];
};

export type GetMetadataIssuesResult = {
    items: MetadataIssue[];
    total: number;
    returned: number;
    offset: number;
    truncated: boolean;
    degraded: string[];
    /** How many films and series were read, so a small `total` can be read as
     *  "few problems" rather than "few looked at". */
    itemsScanned: number;
    /**
     * Items whose files the server would not name, so nothing about them was
     * compared. Reported apart from both `itemsScanned` and `degraded`: the
     * read succeeded, so the instance is not degraded, but the answer for these
     * is "could not look" rather than "nothing is wrong".
     */
    notComparable?: string[];
};

const FIX: Record<Remedy, string> = {
    refresh_metadata: 'fix_metadata — the server holds nothing of its own here, or matched the wrong thing, and re-identifying re-derives it.',
    rename_files:
        'trigger_scan with action "rename" on the managing Radarr or Sonarr, then trigger_scan on Jellyfin. An episode\'s season and number are stored at scan time, so only the file can change.',
    // Deliberately not an instruction. A title-only disagreement on an item the
    // server already matched could be a wrong match or a correct title in
    // another language, and nothing in the comparison separates those. Naming a
    // fix here would send a destructive write at a coin flip.
    inspect:
        'Look before acting: the file and the server disagree on wording only, and this cannot tell which is right. A title in a different language from the filename is a legitimate disagreement. Compare against the managing Radarr or Sonarr.'
};

const project = (issue: MetadataIssue, detail: DetailLevel): MetadataIssue => {
    if (detail === 'full') return issue;
    if (detail === 'standard') {
        const { examples: _e, ...rest } = issue;
        return rest;
    }
    // minimal: which series, how bad, and what to run. `remedy` and `fix` stay
    // — they are the answer, not the detail.
    const { examples: _e, pinned: _p, compared: _c, numbering: _n, titleOnly: _t, ...rest } = issue;
    return rest;
};

const EXAMPLE_LIMIT = 3;

export async function buildGetMetadataIssues(
    adapters: readonly ServiceAdapter[],
    identity: IdentityResolver | undefined,
    opts: { detail: DetailLevel; limit: number; offset: number; user?: string }
): Promise<GetMetadataIssuesResult> {
    const adapter = adapters.find(a => hasMetadataInspect(a) && hasUserLibrary(a));
    const empty = { items: [], total: 0, returned: 0, offset: 0, truncated: false, itemsScanned: 0 };

    if (adapter === undefined || !hasMetadataInspect(adapter) || !hasUserLibrary(adapter) || identity === undefined) {
        // Not an error: no media server is a configuration, not a failure, and
        // `degraded` is for things that were asked and did not answer.
        return { ...empty, degraded: [] };
    }

    const viewer = await identity.resolve(opts.user);
    const library = await adapter.listUserLibrary(viewer);
    const series = library.filter(i => i.kind === 'series' && i.playback?.itemId !== undefined);

    const issues: MetadataIssue[] = [];
    const degraded: string[] = [];
    const notComparable: string[] = [];
    let scanned = 0;

    // Films first, and in one request: they need no per-title read, so the
    // whole film half of the library costs what a single series costs.
    try {
        const movies = await adapter.readMovieMetadata(viewer);
        scanned += movies.length;
        for (const mismatch of findMovieMismatches(movies)) {
            const record = movies.find(m => m.id === mismatch.id);
            const pinned = record !== undefined && pinnedToProvider(record) ? 1 : 0;
            const remedy = movieRemedy(mismatch.reasons, pinned === 1);

            issues.push({
                service: adapter.id,
                itemId: mismatch.id,
                kind: 'movie',
                title: mismatch.serverTitle,
                compared: 1,
                mismatches: 1,
                numbering: mismatch.reasons.includes('year') ? 1 : 0,
                titleOnly: mismatch.reasons.includes('year') ? 0 : 1,
                pinned,
                remedy,
                fix: FIX[remedy],
                examples: [
                    fenceText(
                        `${unfenced(mismatch.path).split(/[/\\]/).at(-1) ?? ''} → ${unfenced(mismatch.serverTitle)}${mismatch.serverYear === undefined ? '' : ` (${mismatch.serverYear})`}`,
                        // The line is a filename and a title together, so the
                        // label names the pair rather than claiming it is a path.
                        { service: adapter.id, field: 'Path/Name' }
                    )
                ]
            });
        }
    } catch (err) {
        logger.warn({ service: adapter.id, err }, 'metadata sweep could not read films');
        if (!degraded.includes(adapter.id)) degraded.push(adapter.id);
    }

    for (const item of series) {
        const itemId = item.playback?.itemId;
        if (itemId === undefined) continue;
        try {
            const episodes = await adapter.readEpisodeMetadata(viewer, itemId);

            // "Could not look" is not "looked and found nothing". A series whose
            // episodes came back with no file paths compared nothing, and
            // counting it as scanned-and-clean is how a sweep of a library the
            // token cannot see file paths for answers "0 items disagree".
            // fix_metadata already refuses this exact state as an error; the two
            // must not contradict each other about the same input.
            if (episodes.length > 0 && episodes.every(e => e.path === undefined || e.path.trim() === '')) {
                notComparable.push(item.title);
                continue;
            }

            scanned += 1;
            const verdict = summariseSeries(episodes);
            if (verdict === undefined) continue;

            const examples = findMismatches(episodes)
                .slice(0, EXAMPLE_LIMIT)
                .map(m => `${unfenced(m.path).split(/[/\\]/).at(-1) ?? ''} → ${unfenced(m.serverTitle)}`);

            issues.push({
                service: adapter.id,
                itemId,
                kind: 'series',
                title: item.title,
                compared: verdict.compared,
                mismatches: verdict.mismatches,
                numbering: verdict.numbering,
                titleOnly: verdict.titleOnly,
                pinned: verdict.pinned,
                remedy: verdict.remedy,
                fix: FIX[verdict.remedy],
                // Re-fenced after the basename split, for the reason
                // fixMetadata's own formatter documents: the closing marker
                // contains a slash, so splitting a fenced path on separators
                // returns the tail of the marker instead of the filename.
                examples: examples.map(e => fenceText(e, { service: adapter.id, field: 'Path/Name' }))
            });
        } catch (err) {
            // One unreadable series must not turn a useful sweep into an
            // error. Named rather than swallowed, so a short list is legible.
            logger.warn({ service: adapter.id, itemId, err }, 'metadata sweep skipped a series');
            if (!degraded.includes(adapter.id)) degraded.push(adapter.id);
        }
    }

    // Worst first: numbering findings outrank title ones, then sheer count.
    // Sorted before projection, where `numbering` is always present.
    issues.sort((a, b) => (b.numbering ?? 0) - (a.numbering ?? 0) || b.mismatches - a.mismatches);

    const paged = applyLimit(issues, opts.limit, opts.offset);
    return {
        ...paged,
        items: paged.items.map(i => project(i, opts.detail)),
        degraded,
        itemsScanned: scanned,
        ...(notComparable.length === 0 ? {} : { notComparable })
    };
}

export function registerGetMetadataIssues(
    server: McpServer,
    adapters: readonly ServiceAdapter[],
    identity: IdentityResolver | undefined
): void {
    server.registerTool(
        'get_metadata_issues',
        {
            title: 'Metadata issues',
            annotations: READ_ONLY,
            description:
                'Sweeps the whole media-server library for series whose metadata does not describe the files on disk, and says which fix each one needs. This is the discovery `fix_metadata` cannot do: that tool needs a title you already suspect, and the point here is finding the ones you do not. Each row splits `numbering` findings (the path\'s own season/episode disagrees with the server — the confident signal) from `titleOnly` ones (the words disagree — advisory), and carries a `remedy`: `refresh_metadata` when the server never matched those episodes and a refresh can fill them in, or `rename_files` when the server matched them and the filename is the outlier, which no metadata refresh moves. **This is slow**: it reads every series\' episodes, one call each, so a large library takes a while. It writes nothing. Titles and paths come from the media server and are fenced as untrusted data.',
            outputSchema: PagedOutputSchema,
            inputSchema: toolInput({ detail: DetailSchema, limit: LimitSchema, offset: OffsetSchema })
        },
        async ({ detail, limit, offset }) => {
            const result = await buildGetMetadataIssues(adapters, identity, { detail, limit, offset });

            const rename = result.items.filter(i => i.remedy === 'rename_files').length;
            const look = result.items.filter(i => i.remedy === 'inspect').length;
            const summary =
                result.itemsScanned === 0
                    ? 'No media server library could be read, so nothing was compared — this is not a clean result.'
                    : `${result.total} of ${result.itemsScanned} items have metadata that disagrees with their files` +
                      (result.total === 0
                          ? '.'
                          : `; ${rename} ${rename === 1 ? 'needs' : 'need'} a rename rather than a metadata refresh` +
                            (look === 0 ? '.' : `, and ${look} ${look === 1 ? 'needs' : 'need'} a look because this cannot tell which side is wrong.`)) +
                      (result.degraded.length > 0 ? ` Some items could not be read (${result.degraded.join(', ')}).` : '') +
                      // Said out loud, because it is the difference between a
                      // quiet library and one nothing could be compared in.
                      (result.notComparable === undefined
                          ? ''
                          : ` ${result.notComparable.length} series had no file paths to compare, so nothing is claimed about them.`);

            return { content: [{ type: 'text', text: summary }], structuredContent: result };
        }
    );
}
