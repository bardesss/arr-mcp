import type { RawEpisode, RawRating, RawTitle } from './imdbDataset.ts';

/**
 * IMDb's dumps into rows (0.8 spec ).
 *
 * **Generators, not arrays.** `title.basics` is on the order of 10⁷ rows, and
 * materialising it costs a multiple of its own size in heap on a machine that
 * is usually a NAS. `replaceAll` consumes these lazily inside one transaction,
 * so peak memory is a row rather than a file.
 *
 * **No CSV library.** These are tab separated with no quoting and no escaping —
 * the format guarantees a tab never appears inside a field — so `split` is both
 * correct and far faster than a parser that has to consider quotes it will
 * never meet.
 */

/** IMDb writes an absent value as this, in every column of every file. */
export const NULL_MARKER = '\\N';

const value = (raw: string | undefined): string | undefined =>
    raw === undefined || raw === '' || raw === NULL_MARKER ? undefined : raw;

/**
 * A numeric column, or nothing.
 *
 * A non-numeric year is corrupt input, not a zero. Dropping the field keeps
 * the row usable; coercing would assert something false about the title, and
 * `Number('')` being `0` is exactly how that happens by accident.
 */
const number = (raw: string | undefined): number | undefined => {
    const text = value(raw);
    if (text === undefined) return undefined;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * Every dump split the same way, header dropped.
 *
 * The header goes by **position**, not by matching the literal string
 * `tconst`: content matching would silently start ingesting the header as data
 * the day IMDb capitalises a column name.
 */
function* rows(lines: Iterable<string>): Generator<string[]> {
    let first = true;

    for (const line of lines) {
        if (first) {
            first = false;
            continue;
        }
        if (line === '') continue;
        yield line.split('\t');
    }
}

/** `tconst titleType primaryTitle originalTitle isAdult startYear endYear runtimeMinutes genres` */
export function* parseTitles(lines: Iterable<string>): Generator<RawTitle> {
    for (const cols of rows(lines)) {
        const tconst = value(cols[0]);
        const kind = value(cols[1]);
        const title = value(cols[2]);
        // A row with no id, type or title cannot be matched, shown or ranked.
        // Dropping it beats carrying a nameless entry into the library join.
        if (tconst === undefined || kind === undefined || title === undefined) continue;

        const year = number(cols[5]);
        const runtime = number(cols[7]);
        const genres = value(cols[8]);

        yield {
            tconst,
            kind,
            title,
            ...(year === undefined ? {} : { year }),
            ...(runtime === undefined ? {} : { runtime }),
            ...(genres === undefined ? {} : { genres })
        };
    }
}

/** `tconst averageRating numVotes` */
export function* parseRatings(lines: Iterable<string>): Generator<RawRating> {
    for (const cols of rows(lines)) {
        const tconst = value(cols[0]);
        const average = number(cols[1]);
        const votes = number(cols[2]);
        if (tconst === undefined || average === undefined || votes === undefined) continue;

        yield { tconst, average, votes };
    }
}

/** `tconst parentTconst seasonNumber episodeNumber` */
export function* parseEpisodes(lines: Iterable<string>): Generator<RawEpisode> {
    for (const cols of rows(lines)) {
        const tconst = value(cols[0]);
        const parent = value(cols[1]);
        if (tconst === undefined || parent === undefined) continue;

        const season = number(cols[2]);
        const episode = number(cols[3]);

        yield {
            tconst,
            parent,
            ...(season === undefined ? {} : { season }),
            ...(episode === undefined ? {} : { episode })
        };
    }
}
