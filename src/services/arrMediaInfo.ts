import { stripDangerous } from '../core/fence.ts';
import type { ServiceHttp } from '../core/http.ts';
import { logger } from '../core/logger.ts';

/** What the *arr services write into `mediaInfo`: a slash-joined list of ISO
 *  names taken off the file itself, e.g. `jpn/eng`. */
export type RawMediaInfo = { audioLanguages?: string | null };

/** Long enough for a file carrying every dub anyone ships; short enough that
 *  one hostile container's language tag cannot cost the whole budget. */
const MAX_LENGTH = 200;

/**
 * Not fenced, unlike the free text beside it. This value exists to be matched
 * — "does it have an `eng` track" — and a boundary marker wrapped around it
 * would make its one job harder than reading the release name it replaces. It
 * still comes off a file nobody vetted, so the code points `fenceText` strips
 * come out of here too.
 *
 * Deduplicated, because the *arrs write one entry per audio *track*: a live
 * Radarr answered `eng/eng/eng/eng/eng/eng` for a film with six English
 * tracks, which reads as six languages. Languages are what this field claims
 * to carry, and the track count is `audioStreamCount`'s job. First-seen order
 * is kept, so the primary track stays first.
 */
export function readAudioLanguages(info: RawMediaInfo | undefined): string | undefined {
    const raw = info?.audioLanguages;
    if (typeof raw !== 'string') return undefined;

    const seen = new Set(
        stripDangerous(raw)
            .split('/')
            .map(part => part.trim())
            .filter(part => part !== '')
    );

    const joined = [...seen].join('/').slice(0, MAX_LENGTH);
    return joined === '' ? undefined : joined;
}

type RawFile = { id?: number; mediaInfo?: RawMediaInfo };

/**
 * `episodeFileId` → the file's audio languages, for one series.
 *
 * A second read, because `/api/v3/episode` carries no `mediaInfo` and the
 * episode rows are where the answer is wanted. It degrades rather than throws:
 * losing one field must not turn a good episode list into "no such series".
 */
export async function audioLanguagesByFileId(
    http: ServiceHttp,
    service: string,
    seriesId: string
): Promise<Map<number, string>> {
    const found = new Map<number, string>();

    try {
        const files = await http.get<RawFile[]>(`/api/v3/episodefile?seriesId=${encodeURIComponent(seriesId)}`);
        if (!Array.isArray(files)) return found;

        for (const file of files) {
            const languages = readAudioLanguages(file.mediaInfo);
            if (typeof file.id === 'number' && languages !== undefined) found.set(file.id, languages);
        }
    } catch (err) {
        logger.warn({ service, err }, 'episode file read failed; answering without audio languages');
    }

    return found;
}
