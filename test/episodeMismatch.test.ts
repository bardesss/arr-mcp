import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    findMismatches,
    findMovieMismatches,
    parseFileNumbering,
    extractFileTitle,
    movieRemedy,
    parseMovieFile,
    summariseSeries,
    type EpisodeRecord
} from '../src/core/episodeMismatch.ts';
import { fenceText } from '../src/core/fence.ts';

const ep = (over: Partial<EpisodeRecord> & Pick<EpisodeRecord, 'id'>): EpisodeRecord => ({
    name: '',
    ...over
});

describe('parseFileNumbering', () => {
    it('reads SxxExx out of a release filename', () => {
        const got = parseFileNumbering(
            '/storage/tv/Attack on Titan/Season 01/Attack on Titan (2013) - S01E02 - 002 - That Day [Bluray-2160p]-Moozzi2.mkv'
        );
        expect(got.season).toBe(1);
        expect(got.episode).toBe(2);
    });

    it('reads the 1x02 form', () => {
        expect(parseFileNumbering('/tv/Show/Season 1/Show 1x02 Something.mkv')).toMatchObject({ season: 1, episode: 2 });
    });

    /**
     * The Dragon Ball Kai case from #199. A Specials folder pins the season to
     * 0 even though the filename itself carries no SxxExx, which is the only
     * signal that catches this shape.
     */
    it('treats a Specials folder as season 0', () => {
        const got = parseFileNumbering("/storage/tv/Dragon Ball Kai (2009)/Specials/Episode 101 Videl's Crisis.mkv");
        expect(got.season).toBe(0);
        expect(got.episode).toBe(101);
    });

    it('treats Season 00 as season 0, not as a missing season', () => {
        expect(parseFileNumbering('/tv/Show/Season 00/Episode 3.mkv').season).toBe(0);
    });

    /**
     * A season folder alone is not episode numbering. Returning a season with
     * no episode must not read as "episode undefined disagrees with 1".
     */
    it('reports a season with no episode when the filename carries no number', () => {
        const got = parseFileNumbering('/tv/Show/Season 03/somefile.mkv');
        expect(got.season).toBe(3);
        expect(got.episode).toBeUndefined();
    });

    it('finds nothing in a path with no numbering at all', () => {
        expect(parseFileNumbering('/tv/Show/movie.mkv')).toEqual({});
    });

    /**
     * 2160p and x265 are resolution and codec, not season 21 episode 60. A
     * greedy digit match reads them as numbering and flags a correct library.
     */
    it('does not read resolution or codec tags as numbering', () => {
        const got = parseFileNumbering('/tv/Show/Season 01/Show - S01E01 - Title [Bluray-2160p][x265 10bit].mkv');
        expect(got.season).toBe(1);
        expect(got.episode).toBe(1);
    });
});

describe('findMismatches', () => {
    it('is silent on a library whose filenames agree with its metadata', () => {
        const items: EpisodeRecord[] = [
            ep({
                id: 'a',
                name: 'To You, in 2,000 Years: The Fall of Shiganshina (1)',
                season: 1,
                episode: 1,
                path: '/storage/tv/Attack on Titan/Season 01/Attack on Titan (2013) - S01E01 - 001 - To You in 2,000 Years The Fall of Shiganshina 1 [Bluray-2160p][FLAC 5.1][JA][x265 10bit]-Moozzi2.mkv'
            })
        ];
        expect(findMismatches(items)).toEqual([]);
    });

    /** The acceptance case: file is a special, Jellyfin calls it S1E1. */
    it('flags a special that the server numbered into season 1', () => {
        const items: EpisodeRecord[] = [
            ep({
                id: 'k',
                name: 'Prologue to Battle! The Return of Goku!',
                season: 1,
                episode: 1,
                path: "/storage/tv/Dragon Ball Kai (2009) [tvdbid-88031]/Specials/Episode 101 Videl's Crisis Gohan's Urgent Call-out!.mkv"
            })
        ];

        const [found, ...rest] = findMismatches(items);
        expect(rest).toEqual([]);
        expect(found?.id).toBe('k');
        expect(found?.reasons).toContain('numbering');
        expect(found?.fileSeason).toBe(0);
        expect(found?.serverSeason).toBe(1);
    });

    it('flags a title that shares no words with the filename', () => {
        const items: EpisodeRecord[] = [
            ep({
                id: 't',
                name: 'Prologue to Battle! The Return of Goku!',
                season: 0,
                episode: 101,
                path: "/tv/Dragon Ball Kai/Specials/Episode 101 Videl's Crisis Gohan's Urgent Call-out!.mkv"
            })
        ];

        const [found] = findMismatches(items);
        expect(found?.reasons).toEqual(['title']);
    });

    /**
     * Stopwords are the trap here. "to", "the" and "of" appear in most English
     * episode titles, so counting them as shared words makes two unrelated
     * titles look related and the check never fires.
     */
    it('does not count stopwords as agreement between two unrelated titles', () => {
        const items: EpisodeRecord[] = [
            ep({
                id: 's',
                name: 'The Return of the King',
                season: 1,
                episode: 1,
                path: '/tv/Show/Season 01/Show - S01E01 - To the End of the Line.mkv'
            })
        ];
        expect(findMismatches(items)[0]?.reasons).toEqual(['title']);
    });

    /**
     * Precision over recall: this tool overwrites metadata irreversibly, so a
     * filename that carries no usable title must produce no finding rather
     * than a guess.
     */
    it('says nothing when the filename has no title to compare', () => {
        const items: EpisodeRecord[] = [
            ep({ id: 'n', name: 'Some Real Title', season: 1, episode: 1, path: '/tv/Show/Season 01/S01E01.mkv' })
        ];
        expect(findMismatches(items)).toEqual([]);
    });

    it('says nothing about an episode with no path, rather than guessing', () => {
        const items: EpisodeRecord[] = [ep({ id: 'p', name: 'Whatever', season: 4, episode: 2 })];
        expect(findMismatches(items)).toEqual([]);
    });

    /** Names arrive fenced from the adapter; comparing the fence marker itself
     *  would make every title look different from its filename. */
    it('compares through the untrusted-data fence', () => {
        const items: EpisodeRecord[] = [
            ep({
                id: 'f',
                name: fenceText('That Day', { service: 'jellyfin', field: 'Name' }),
                season: 1,
                episode: 2,
                path: '/tv/Attack on Titan/Season 01/Attack on Titan - S01E02 - That Day [Bluray-2160p]-Moozzi2.mkv'
            })
        ];
        expect(findMismatches(items)).toEqual([]);
    });

    it('reports both reasons when numbering and title disagree together', () => {
        const items: EpisodeRecord[] = [
            ep({
                id: 'b',
                name: 'Prologue to Battle! The Return of Goku!',
                season: 1,
                episode: 1,
                path: "/tv/Dragon Ball Kai/Specials/Episode 101 Videl's Crisis Gohan's Urgent Call-out!.mkv"
            })
        ];
        expect(findMismatches(items)[0]?.reasons).toEqual(['numbering', 'title']);
    });
});

/**
 * The false-positive guard, and the reason it uses the real capture rather
 * than hand-written rows: `fix_metadata` overwrites metadata irreversibly, so
 * the heuristic firing on a healthy library is the expensive failure. These 25
 * episodes are a correctly matched season straight off a live Jellyfin,
 * release tags and all. Every one of them must come back clean.
 */
describe('findMismatches against the captured library', () => {
    type RawEpisode = {
        Id?: string;
        Name?: string;
        ParentIndexNumber?: number;
        IndexNumber?: number;
        Path?: string;
    };

    const raw = JSON.parse(readFileSync('test/fixtures/jellyfin/show-episodes.json', 'utf8')) as { Items?: RawEpisode[] };
    const items: EpisodeRecord[] = (raw.Items ?? []).map(e => ({
        id: e.Id ?? '',
        name: e.Name ?? '',
        ...(e.ParentIndexNumber === undefined ? {} : { season: e.ParentIndexNumber }),
        ...(e.IndexNumber === undefined ? {} : { episode: e.IndexNumber }),
        ...(e.Path === undefined ? {} : { path: e.Path })
    }));

    it('has paths to compare, or the guard below proves nothing', () => {
        expect(items.length).toBeGreaterThan(0);
        expect(items.every(i => i.path !== undefined)).toBe(true);
    });

    it('reports nothing on a correctly matched season', () => {
        expect(findMismatches(items)).toEqual([]);
    });
});

describe('fenced paths', () => {
    /** The adapter fences `Path` like every other server-supplied string, so
     *  the parser has to see through it or the last segment carries a closing
     *  marker and the extension strip never matches. */
    it('parses numbering out of a fenced path', () => {
        const fenced = fenceText('/tv/Show/Season 02/Show - S02E05 - Some Title.mkv', {
            service: 'jellyfin',
            field: 'Path'
        });
        expect(parseFileNumbering(fenced)).toMatchObject({ season: 2, episode: 5 });
    });

    it('finds no mismatch on a fenced path that agrees with its metadata', () => {
        const items: EpisodeRecord[] = [
            ep({
                id: 'z',
                name: fenceText('Some Title', { service: 'jellyfin', field: 'Name' }),
                season: 2,
                episode: 5,
                path: fenceText('/tv/Show/Season 02/Show - S02E05 - Some Title.mkv', { service: 'jellyfin', field: 'Path' })
            })
        ];
        expect(findMismatches(items)).toEqual([]);
    });
});

/**
 * Found by sweeping a real 101-series library rather than by imagination: a
 * scene release carries no episode title at all, and without a release-tag
 * filter the extractor reads the tags as the title and flags a correct episode.
 * This was the only false positive in that sweep, and it produced three of the
 * five findings in it.
 */
describe('scene releases that carry no episode title', () => {
    it('does not flag Rick and Morty S03E07, whose server title is correct', () => {
        const items: EpisodeRecord[] = [
            ep({
                id: 'rm',
                name: 'The Ricklantis Mixup',
                season: 3,
                episode: 7,
                path: '/tv/Rick and Morty/Season 03/Rick.and.Morty.S03E07.1080p.BluRay.x264-YELLOWBiRD English.mkv'
            })
        ];
        expect(findMismatches(items)).toEqual([]);
    });

    it('reads dots as separators, not as part of one long token', () => {
        expect(parseFileNumbering('/tv/Show/Season 03/Show.Name.S03E07.1080p.WEB-DL.mkv')).toMatchObject({
            season: 3,
            episode: 7
        });
    });

    /**
     * The cost of the rule, stated as a test so it is a decision rather than a
     * surprise: an undelimited scene name is never title-checked, even when it
     * happens to contain a real title. Recall is given up for precision here
     * because the repair this feeds is irreversible.
     */
    it('does not title-check an undelimited name even when it carries a title', () => {
        const items: EpisodeRecord[] = [
            ep({
                id: 'sc',
                name: 'Something Else Entirely',
                season: 3,
                episode: 7,
                path: '/tv/Show/Season 03/Show.Name.S03E07.The.Ricklantis.Mixup.1080p.BluRay.x264-GROUP.mkv'
            })
        ];
        expect(findMismatches(items)).toEqual([]);
    });

    /** A delimited name is still trusted — this is the library-manager shape. */
    it('title-checks a delimited name with a single field', () => {
        const items: EpisodeRecord[] = [
            ep({
                id: 'd',
                name: 'Something Else Entirely',
                season: 3,
                episode: 7,
                path: '/tv/Show/Season 03/Show - S03E07 - The Ricklantis Mixup.mkv'
            })
        ];
        expect(findMismatches(items)[0]?.reasons).toEqual(['title']);
    });
});

/**
 * The remedy rule, and the three real series behind it. A title mismatch says
 * the file and the server disagree; it does not say which is wrong. Whether the
 * server ever matched the episode is what separates the two directions.
 */
describe('summariseSeries', () => {
    const withIds = (over: Partial<EpisodeRecord> & Pick<EpisodeRecord, 'id'>): EpisodeRecord =>
        ep({ providerIds: { Tvdb: '123' }, ...over });

    it('says nothing about a series whose files all agree', () => {
        expect(
            summariseSeries([
                ep({ id: 'a', name: 'Real Title', season: 1, episode: 1, path: '/tv/S/Season 01/S - S01E01 - Real Title.mkv' })
            ])
        ).toBeUndefined();
    });

    /** The DTF St. Louis shape: the server never matched these, so it holds no
     *  episode metadata and a refresh can fill it in. */
    it('sends an unmatched title mismatch to a metadata refresh', () => {
        const verdict = summariseSeries([
            ep({ id: 'u', name: 'DTF St. Louis', season: 1, episode: 4, path: '/tv/D/Season 01/D - S01E04 - Missouri Mutual Life.mkv' })
        ]);
        expect(verdict).toMatchObject({ mismatches: 1, numbering: 0, titleOnly: 1, pinned: 0, remedy: 'refresh_metadata' });
    });

    /**
     * The Furious shape. This used to be sent to a rename on the strength of one
     * series where the filenames were the outlier — but the identical finding is
     * produced by a server holding correct titles in another language, and
     * nothing here separates the two. It says "look" rather than naming a fix.
     */
    it('refuses to name a fix for a matched title mismatch', () => {
        const verdict = summariseSeries([
            withIds({ id: 'p', name: 'My Life Had Stood a Loaded Gun', season: 1, episode: 2, path: '/tv/F/Season 01/F - S01E02 - Flash Flood.mkv' })
        ]);
        expect(verdict).toMatchObject({ mismatches: 1, titleOnly: 1, pinned: 1, remedy: 'inspect' });
    });

    /** The Dragon Ball Kai shape. Numbering is stored at scan time and no
     *  refresh re-derives it, matched or not. */
    it('sends any numbering mismatch to a rename', () => {
        const verdict = summariseSeries([
            ep({ id: 'n', name: 'Prologue to Battle!', season: 1, episode: 1, path: '/tv/K/Specials/Episode 101 Videls Crisis.mkv' })
        ]);
        expect(verdict).toMatchObject({ numbering: 1, remedy: 'rename_files' });
    });

    /** A mixed series still goes to the refresh: it is the tool that can help
     *  the unmatched half, and it refuses to pretend about the rest. */
    it('sends a partly matched series to the refresh, which can help half of it', () => {
        const verdict = summariseSeries([
            // Two content words on each side, or the comparison declines to
            // fire at all and this stops testing the mixed case.
            withIds({ id: 'p', name: 'Completely Different Title', season: 1, episode: 2, path: '/tv/F/Season 01/F - S01E02 - Flash Flood Warning.mkv' }),
            ep({ id: 'u', name: 'Series Name', season: 1, episode: 3, path: '/tv/F/Season 01/F - S01E03 - Real Episode Title.mkv' })
        ]);
        expect(verdict).toMatchObject({ mismatches: 2, pinned: 1, remedy: 'refresh_metadata' });
    });

    it('counts what it could compare, not what it was handed', () => {
        const verdict = summariseSeries([
            ep({ id: 'n', name: 'X', season: 1, episode: 1, path: '/tv/K/Specials/Episode 101 Videls Crisis.mkv' }),
            ep({ id: 'nopath', name: 'Y', season: 1, episode: 2 })
        ]);
        expect(verdict?.compared).toBe(1);
    });
});

/**
 * The film parser, and the false positive that shaped it. A bare four-digit
 * token is not a year, it is a number that looks like one, and several real
 * films are named after years.
 */
describe('parseMovieFile', () => {
    it('reads the parenthesised year and the title before it', () => {
        expect(parseMovieFile('/movies/Alien (1979)/Alien (1979) [Bluray-1080p].mkv')).toEqual({
            title: 'Alien',
            year: 1979
        });
    });

    it('does not read a year out of a title that is a number', () => {
        // Caught by a test rather than by a library: stripping brackets first
        // removed (2017) and left 2049 looking like the year.
        expect(parseMovieFile('/movies/Blade Runner 2049 (2017)/Blade Runner 2049 (2017) [Bluray-2160p].mkv')).toEqual({
            title: 'Blade Runner 2049',
            year: 2017
        });
    });

    it('claims nothing when there is no parenthesised year', () => {
        expect(parseMovieFile('/movies/The.Matrix.1999.1080p.BluRay.x264-GROUP.mkv')).toEqual({});
    });
});

describe('findMovieMismatches', () => {
    const film = (over: Partial<import('../src/core/episodeMismatch.ts').MovieRecord> & { id: string }) => ({
        name: '',
        ...over
    });

    it('is silent on a film whose file agrees with it', () => {
        expect(
            findMovieMismatches([
                film({ id: 'a', name: 'Alien', year: 1979, path: '/movies/Alien (1979)/Alien (1979) [Bluray-1080p].mkv' })
            ])
        ).toEqual([]);
    });

    it('flags a year that disagrees, which means a different film was matched', () => {
        const [found] = findMovieMismatches([
            film({ id: 'y', name: 'The Thing', year: 2011, path: '/movies/The Thing (1982)/The Thing (1982).mkv' })
        ]);
        expect(found?.reasons).toEqual(['year']);
        expect(found?.fileYear).toBe(1982);
        expect(found?.serverYear).toBe(2011);
    });

    it('says nothing about a film with no file', () => {
        expect(findMovieMismatches([film({ id: 'n', name: 'Alien', year: 1979 })])).toEqual([]);
    });
});

/**
 * Every one of these was a false positive found by review rather than by the
 * suite, on a library shaped unlike the one this was developed against. The
 * detector feeds an irreversible write, so each gets a test.
 */
describe('false positives found by review', () => {
    it('reads a four-digit episode number, rather than dropping the fourth digit', () => {
        // Sonarr's default {episode:00} emits E1000 past 999. Read as episode
        // 100, every long-running anime got a confident numbering finding.
        expect(parseFileNumbering('/tv/One Piece/Season 21/One Piece - S21E1000 - Overwhelming Strength.mkv')).toMatchObject({
            season: 21,
            episode: 1000
        });
    });

    it('does not read a series title as numbering', () => {
        // 2x2 Shinobuden is a real series; 4x4 Adventures stands for the shape.
        expect(parseFileNumbering('/tv/2x2 Shinobuden/Season 01/2x2 Shinobuden - Episode 1 - Ninja Nonsense.mkv')).toMatchObject({
            season: 1,
            episode: 1
        });
    });

    it('does not read a resolution tag as numbering', () => {
        expect(parseFileNumbering('/tv/Old Show/Season 01/Old Show - Episode 3 - The Pilot 640x480.avi')).toMatchObject({
            season: 1,
            episode: 3
        });
    });

    it('takes the last numbering in the name, so a title containing one is not a decoy', () => {
        expect(parseFileNumbering('/tv/The S1E1 Podcast/Season 02/The S1E1 Podcast - S02E03 - Title.mkv')).toMatchObject({
            season: 2,
            episode: 3
        });
    });

    it('takes the first title field, not the longest, so release tags do not win', () => {
        expect(extractFileTitle('/tv/S/Season 01/Show - S01E01 - Pilot - AMZN WEB-DL DDP5.1 H.264-NTb.mkv')).toBe('Pilot');
    });

    /** Sonarr and Radarr name files in English; a server set to another
     *  metadata language disagrees on every title while both are correct. */
    it('does not compare titles across scripts', () => {
        const items: EpisodeRecord[] = [
            ep({
                id: 'ja',
                name: '進撃の巨人 第一話',
                season: 1,
                episode: 1,
                path: '/tv/AoT/Season 01/AoT - S01E01 - Shingeki no Kyojin.mkv'
            })
        ];
        expect(findMismatches(items)).toEqual([]);
    });

    /** Radarr names a file with the year it held at import; TMDB moves festival
     *  and limited dates across a year boundary afterwards. */
    it('tolerates a one-year drift on a film', () => {
        expect(
            findMovieMismatches([
                { id: 'd', name: 'Some Film', year: 2024, path: '/movies/Some Film (2023)/Some Film (2023) [Bluray-1080p].mkv' }
            ])
        ).toEqual([]);
    });

    it('still flags a film that is two years out', () => {
        expect(
            findMovieMismatches([
                { id: 'w', name: 'The Thing', year: 2011, path: '/movies/The Thing (1982)/The Thing (1982).mkv' }
            ])[0]?.reasons
        ).toEqual(['year']);
    });

    it('takes the last parenthesised year', () => {
        expect(parseMovieFile('/movies/Death Race 2000 (2008)/Death Race 2000 (2008).mkv')).toMatchObject({ year: 2008 });
    });
});

describe('movieRemedy', () => {
    /** The episode rule does not carry over. A film's year comes from the
     *  provider match, not from a scan-time index, so re-identifying re-derives
     *  it — and every matched film is pinned, so the episode rule would have
     *  sent every single film finding to a pointless rename. */
    it('sends a wrong year to a re-identify, even though the film is matched', () => {
        expect(movieRemedy(['year'], true)).toBe('refresh_metadata');
    });

    it('refuses to name a fix for a matched title-only disagreement', () => {
        expect(movieRemedy(['title'], true)).toBe('inspect');
    });

    it('fills in an unmatched film', () => {
        expect(movieRemedy(['title'], false)).toBe('refresh_metadata');
    });
});
