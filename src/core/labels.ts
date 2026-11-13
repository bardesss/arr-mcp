/** `Title (2021)`, or the bare title when the year is unknown, which Radarr sends as 0. */
export const titled = (title: string, year: number | string | undefined): string =>
    year === undefined || year === 0 || year === '' ? title : `${title} (${year})`;

/** `S01E02`. */
export const episodeCode = (season: number, episode: number): string =>
    `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
