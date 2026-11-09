/** `Title (2021)`, or the bare title when the year is unknown. */
export const titled = (title: string, year: number | string | undefined): string =>
    year === undefined ? title : `${title} (${year})`;

/** `S01E02`. */
export const episodeCode = (season: number, episode: number): string =>
    `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
