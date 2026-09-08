/**
 * Does the file on disk agree with the metadata the media server put on it?
 *
 * This is the detect half of `fix_metadata` (#199), kept pure and separate
 * from any adapter because the repair it feeds is irreversible: a false
 * positive here ends with correct metadata overwritten. So the bias
 * throughout is precision over recall — every branch that cannot tell
 * returns nothing rather than a guess.
 *
 * Two independent signals, reported separately because they are not equally
 * trustworthy:
 *
 * - `numbering` — the season/episode the path states versus the one the
 *   server holds. High confidence. A `SxxExx` or a `Specials` folder is an
 *   explicit claim, not an inference.
 * - `title` — the words in the filename versus the words in the server's
 *   title. Advisory. Honest disagreements are common and legitimate: a
 *   romanised filename against an English title shares no words while both
 *   are correct.
 *
 * A caller showing this to a human should say which reason it was.
 */
import { normaliseTitle, unfenced } from './titleMatch.ts';

export type EpisodeRecord = {
    id: string;
    /** The server's title. May arrive fenced; comparison unfences it. */
    name: string;
    /** The server's season number. Jellyfin's `ParentIndexNumber`. */
    season?: number;
    /** The server's episode number. Jellyfin's `IndexNumber`. */
    episode?: number;
    /** Absent unless the read asked for it — see `Fields=Path`. */
    path?: string;
    /**
     * The episode's *own* provider ids, where the server holds any.
     *
     * Load-bearing rather than informational: an episode pinned to a provider
     * id is re-fetched from that id by a full refresh, so a refresh re-writes
     * the same metadata it already had. An episode pinned to the *wrong* id
     * therefore cannot be repaired by refreshing it — see `pinnedToProvider`.
     */
    providerIds?: Record<string, string>;
};

/**
 * Whether this episode's metadata comes from an id stored on the episode
 * itself, rather than being re-derived from the file each refresh.
 *
 * This is the difference between a repairable mismatch and one that will
 * survive any number of full refreshes.
 */
export const pinnedToProvider = (item: { providerIds?: Record<string, string> }): boolean =>
    item.providerIds !== undefined && Object.keys(item.providerIds).length > 0;

export type MismatchReason = 'numbering' | 'title' | 'year';

/**
 * A film, which has no episode numbering to compare and so needs its own
 * confident signal. The year is that signal: a film file names its year far
 * more reliably than an episode file names its title, and a year that
 * disagrees means the server matched a different film, not a differently
 * worded one.
 */
export type MovieRecord = {
    id: string;
    name: string;
    year?: number;
    path?: string;
    providerIds?: Record<string, string>;
};

export type Mismatch = {
    id: string;
    path: string;
    serverTitle: string;
    serverSeason?: number;
    serverEpisode?: number;
    fileSeason?: number;
    fileEpisode?: number;
    fileTitle?: string;
    /** Films only. */
    serverYear?: number;
    fileYear?: number;
    /** Most trustworthy first: `numbering` before `title`. */
    reasons: MismatchReason[];
};

/** Release tags live in brackets and are full of digits that read as
 *  numbering — `2160p`, `x265 10bit`, `FLAC 5.1`. Numbering and title are both
 *  parsed with these removed. */
const BRACKETED = /\[[^\]]*\]|\([^)]*\)/g;

const SEASON_EPISODE = /[Ss](\d{1,3})[Ee](\d{1,3})/;
const SEASON_X_EPISODE = /\b(\d{1,3})x(\d{1,3})\b/;
const EPISODE_WORD = /\bepisode\s*(\d{1,4})\b/i;
const SEASON_FOLDER = /^season\s*(\d{1,3})$/i;
const SPECIALS_FOLDER = /^specials?$/i;

/** Paths arrive fenced from the adapter. The fence markers sit at the ends of
 *  the string, where they would otherwise be read as part of the first and last
 *  path segment. */
const segments = (path: string): string[] => unfenced(path).split(/[/\\]/).filter(s => s !== '');

const withoutExtension = (name: string): string => name.replace(/\.[A-Za-z0-9]{2,4}$/, '');

/**
 * What the path itself claims about season and episode. Either half can be
 * absent — a `Season 03` folder with an unparseable filename genuinely knows
 * the season and not the episode, and saying so is not the same as claiming
 * episode zero.
 */
export function parseFileNumbering(path: string): { season?: number; episode?: number } {
    const parts = segments(path);
    const base = withoutExtension(parts.at(-1) ?? '').replace(BRACKETED, ' ');
    const parent = parts.at(-2) ?? '';

    let season: number | undefined;
    let episode: number | undefined;

    // The folder is the weaker claim, so it goes first and an explicit
    // SxxExx in the filename overwrites it below.
    if (SPECIALS_FOLDER.test(parent.trim())) {
        season = 0;
    } else {
        const folder = SEASON_FOLDER.exec(parent.trim());
        if (folder?.[1] !== undefined) season = Number(folder[1]);
    }

    const sxe = SEASON_EPISODE.exec(base) ?? SEASON_X_EPISODE.exec(base);
    if (sxe?.[1] !== undefined && sxe[2] !== undefined) {
        season = Number(sxe[1]);
        episode = Number(sxe[2]);
    } else {
        const worded = EPISODE_WORD.exec(base);
        if (worded?.[1] !== undefined) episode = Number(worded[1]);
    }

    return {
        ...(season === undefined ? {} : { season }),
        ...(episode === undefined ? {} : { episode })
    };
}

/**
 * The human-readable part of a filename, or nothing when there isn't one.
 *
 * Only the text *after* the numbering counts. Everything before it is the
 * series name, which agrees with the server on a broken library just as
 * readily as on a healthy one and would mask the disagreement being looked
 * for.
 */
export function extractFileTitle(path: string): string | undefined {
    // Dots are the scene separator, so they become spaces before anything else
    // looks at words. Left as dots, `1080p.BluRay.x264` is one long token that
    // no tag pattern matches and no title ever shares.
    const base = withoutExtension(segments(path).at(-1) ?? '')
        .replace(BRACKETED, ' ')
        .replace(/\./g, ' ');

    const numbered = SEASON_EPISODE.exec(base) ?? SEASON_X_EPISODE.exec(base);
    const worded = numbered === null ? EPISODE_WORD.exec(base) : null;
    const marker = numbered ?? worded;
    if (marker === null) return undefined;

    const after = base.slice(marker.index + marker[0].length);

    /**
     * The discriminator between "this filename contains a title" and "this
     * filename contains release tags", and it is a naming convention rather
     * than a guess about the words themselves.
     *
     * A library-manager name delimits its fields: `… - S01E01 - 001 - Title
     * [tags]`. A scene release does not: `Show.Name.S03E07.1080p.WEB-DL.x264-
     * GROUP` carries no episode title at all. Trying to read a title out of
     * the second kind is what produced every false positive in a sweep of a
     * real 101-series library — six series flagged whose server titles were
     * all correct.
     *
     * So an `SxxExx` name must have a delimited field after the numbering for
     * its title to be trusted. `Episode 101 Videl's Crisis` is exempt: the
     * word form is not a scene convention, and what follows it is the title by
     * construction.
     */
    // The delimiter itself is the signal, not how many fields survive: a
    // perfectly ordinary `Show - S01E01 - Title` has exactly one.
    if (numbered !== null && !/\s-\s/.test(after)) return undefined;

    const fields = after
        .split(/\s+-\s+|\s{2,}/)
        .map(part => part.replace(/-[A-Za-z0-9_.]+$/, '').trim())
        .filter(part => part !== '' && !/^\d+$/.test(part));

    // The absolute episode number sits in its own ` - 001 - ` field between the
    // numbering and the title, so take the longest field rather than the first.
    const candidate = fields.sort((a, b) => b.length - a.length)[0];
    return candidate === undefined || candidate === '' ? undefined : candidate;
}

/**
 * Words too common to mean anything when two titles share them. Without this
 * the overlap test is satisfied by "the" and never fires — most English
 * episode titles share at least one of these with most others.
 */
/**
 * Resolution, source, codec and language tags. A scene release often carries
 * no episode title at all — `Rick.and.Morty.S03E07.1080p.BluRay.x264-GROUP` —
 * and without this the extractor treats the tags themselves as the title,
 * finds nothing in common with the real one, and flags a correct episode.
 *
 * Found by sweeping a real 101-series library: it was the only false positive,
 * and it was three of the five findings in it.
 */
const RELEASE_TAGS =
    /^(?:\d{3,4}[ip]|[xh]26[45]|hevc|avc|bluray|blu-ray|webrip|web-?dl|hdtv|dvdrip|remux|proper|repack|extended|uncut|aac\d?|ac3|eac3|dts(?:-hd)?|truehd|flac|opus|atmos|\d+bit|\d+(?:\.\d+)?ch|multi|dual|dub(?:bed)?|sub(?:bed|s)?|english|japanese|german|french|spanish|italian|dutch)$/i;

const STOPWORDS = new Set([
    'the',
    'and',
    'that',
    'this',
    'with',
    'for',
    'from',
    'was',
    'are',
    'but',
    'not',
    'you',
    'your',
    'his',
    'her',
    'its',
    'our',
    'their',
    'part'
]);

/** Short words carry too little signal to count as agreement, so the floor is
 *  three characters — which also drops "to", "of", "in" without listing them. */
const contentWords = (value: string): Set<string> =>
    new Set(
        normaliseTitle(value)
            .split(' ')
            .filter(word => word.length >= 3 && !STOPWORDS.has(word) && !RELEASE_TAGS.test(word))
    );

/** Fewer than this many usable words on either side and the comparison is not
 *  worth making — "That Day" reduces to one word, and one word agreeing or
 *  disagreeing is noise. */
const MIN_WORDS = 2;

/**
 * True only when both titles are substantial enough to compare *and* share
 * nothing at all. Partial disagreement is deliberately not a finding:
 * punctuation, transliteration and part-numbering differ constantly on
 * correct libraries.
 */
function titlesDisagree(serverTitle: string, fileTitle: string): boolean {
    const server = contentWords(serverTitle);
    const file = contentWords(fileTitle);
    if (server.size < MIN_WORDS || file.size < MIN_WORDS) return false;
    for (const word of file) {
        if (server.has(word)) return false;
    }
    return true;
}

/**
 * Which way round the disagreement points, and therefore which tool fixes it.
 *
 * A title mismatch says the file and the server disagree. It does not say
 * which one is wrong — and both directions are real. What separates them is
 * whether the server ever matched the episode at all:
 *
 * - **No provider ids.** The server never matched it and holds no episode
 *   metadata, so there is nothing for the file to contradict. A refresh can
 *   fill it in. (Measured: a series whose episodes were titled after the
 *   series itself; `fix_metadata` repaired both.)
 * - **Provider ids present.** The server matched it, so the server's title is
 *   the considered one and the filename is the outlier. Refreshing rewrites
 *   what is already correct. (Measured: a series where the first three files
 *   carried titles belonging to episodes 7, 4 and 6, and both the server and
 *   Sonarr had it right.)
 *
 * Numbering mismatches always want a rename: an episode's season and number
 * are stored on the item at scan time and no refresh re-derives them.
 *
 * Three real series stand behind this, which is enough to act on and not
 * enough to be certain. Callers should present it as the likely fix, not a
 * verdict.
 */
export type Remedy = 'refresh_metadata' | 'rename_files';

export type SeriesVerdict = {
    /** How many episodes had a file to compare at all. */
    compared: number;
    mismatches: number;
    numbering: number;
    titleOnly: number;
    /** Of the mismatching episodes, how many the server had already matched. */
    pinned: number;
    remedy: Remedy;
};

export function summariseSeries(items: readonly EpisodeRecord[]): SeriesVerdict | undefined {
    const compared = items.filter(i => i.path !== undefined && i.path.trim() !== '').length;
    const mismatches = findMismatches(items);
    if (mismatches.length === 0) return undefined;

    const byId = new Map(items.map(i => [i.id, i]));
    const numbering = mismatches.filter(m => m.reasons.includes('numbering')).length;
    const pinned = mismatches.filter(m => {
        const record = byId.get(m.id);
        return record !== undefined && pinnedToProvider(record);
    }).length;

    return {
        compared,
        mismatches: mismatches.length,
        numbering,
        titleOnly: mismatches.length - numbering,
        pinned,
        // A mixed series still goes to `fix_metadata`: it is the tool that can
        // help the unpinned half, and it refuses to pretend about the rest.
        remedy: numbering > 0 || pinned === mismatches.length ? 'rename_files' : 'refresh_metadata'
    };
}

/**
 * The **parenthesised** year only, and that is the precision guard rather than
 * pedantry.
 *
 * A bare four-digit token is not a year, it is a number that looks like one:
 * `Blade Runner 2049 (2017)` reads as year 2049 and title "Blade Runner", which
 * then disagrees with a perfectly correct server record. `1917`, `2012` and
 * `Blade Runner 2049` are all real films whose titles are years.
 *
 * `(YYYY)` is the library-manager convention and is unambiguous, the same
 * "delimited form or no claim" rule the episode title extractor uses.
 */
const MOVIE_YEAR = /\((19|20)\d{2}\)/;

/**
 * What a film's filename claims: its title and its year.
 *
 * The year is required, and that is the precision guard. A film file names its
 * year almost universally (`Alien (1979) …`, `Alien.1979.1080p…`), and without
 * one there is no reliable boundary between the title and the release tags —
 * the same trap that made scene episode names unreadable. No year, no claim.
 */
export function parseMovieFile(path: string): { title?: string; year?: number } {
    // Read before any bracket stripping: the year lives in the parentheses that
    // stripping would remove, and removing it first is what made
    // `Blade Runner 2049 (2017)` parse as year 2049.
    const raw = withoutExtension(segments(path).at(-1) ?? '');

    const found = MOVIE_YEAR.exec(raw);
    if (found === null) return {};

    const year = Number(found[0].slice(1, -1));
    // Everything before the year is the title; everything after it is tags.
    const title = raw
        .slice(0, found.index)
        .replace(BRACKETED, ' ')
        .replace(/\./g, ' ')
        .trim();

    return { ...(title === '' ? {} : { title }), year };
}

/**
 * Films whose file disagrees with their metadata. Same bias as the episode
 * pass: anything it cannot read confidently produces no finding.
 */
export function findMovieMismatches(items: readonly MovieRecord[]): Mismatch[] {
    const out: Mismatch[] = [];

    for (const item of items) {
        const path = item.path;
        if (path === undefined || path.trim() === '') continue;

        const { title: fileTitle, year: fileYear } = parseMovieFile(path);
        const reasons: MismatchReason[] = [];

        if (fileYear !== undefined && item.year !== undefined && fileYear !== item.year) reasons.push('year');
        if (fileTitle !== undefined && titlesDisagree(item.name, fileTitle)) reasons.push('title');
        if (reasons.length === 0) continue;

        out.push({
            id: item.id,
            path,
            serverTitle: item.name,
            ...(item.year === undefined ? {} : { serverYear: item.year }),
            ...(fileYear === undefined ? {} : { fileYear }),
            ...(fileTitle === undefined ? {} : { fileTitle }),
            reasons
        });
    }

    return out;
}

/**
 * Every episode whose file disagrees with its metadata, in the order given.
 * An episode with no path is skipped rather than reported: without the file
 * there is nothing to disagree with.
 */
export function findMismatches(items: readonly EpisodeRecord[]): Mismatch[] {
    const out: Mismatch[] = [];

    for (const item of items) {
        const path = item.path;
        if (path === undefined || path.trim() === '') continue;

        const { season: fileSeason, episode: fileEpisode } = parseFileNumbering(path);
        const fileTitle = extractFileTitle(path);
        const reasons: MismatchReason[] = [];

        // Only where both sides actually state a value. An absent number is
        // not a disagreement with the number that is present.
        const numberingOff =
            (fileSeason !== undefined && item.season !== undefined && fileSeason !== item.season) ||
            (fileEpisode !== undefined && item.episode !== undefined && fileEpisode !== item.episode);
        if (numberingOff) reasons.push('numbering');

        if (fileTitle !== undefined && titlesDisagree(item.name, fileTitle)) reasons.push('title');

        if (reasons.length === 0) continue;

        out.push({
            id: item.id,
            path,
            serverTitle: item.name,
            ...(item.season === undefined ? {} : { serverSeason: item.season }),
            ...(item.episode === undefined ? {} : { serverEpisode: item.episode }),
            ...(fileSeason === undefined ? {} : { fileSeason }),
            ...(fileEpisode === undefined ? {} : { fileEpisode }),
            ...(fileTitle === undefined ? {} : { fileTitle }),
            reasons
        });
    }

    return out;
}
