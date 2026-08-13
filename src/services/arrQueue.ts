import { ServiceError } from '../core/errors.ts';
import { fenceText } from '../core/fence.ts';
import type { ServiceHttp } from '../core/http.ts';
import type { CalendarEntry, DeleteMediaOptions, QueueItem, RemoveQueueOptions } from './types.ts';

/**
 * Radarr and Sonarr share a framework, so their queue and calendar responses
 * differ only in the fields naming the media. One implementation, two services.
 */

type RawQueueRecord = {
    id?: number;
    title?: string;
    status?: string;
    protocol?: string;
    size?: number;
    sizeleft?: number;
    timeleft?: string;
    errorMessage?: string;
};
type RawQueuePage = { records?: RawQueueRecord[]; totalRecords?: number };

/**
 * Sent explicitly because Radarr and Sonarr default `pageSize` to 10. Asking
 * for none meant a household with more than ten downloads was told ten was the
 * queue, and nothing could report the truncation: `records` is everything the
 * caller sees, so `applyLimit` counted ten items and called that the total.
 * The captured fixture echoes `"pageSize": 10` and `"totalRecords": 0` — an
 * empty queue at capture time, which is why no test caught it.
 *
 * Paged to completion rather than raised to one large number, because a bigger
 * silent cap is the same defect with a longer fuse.
 */
const QUEUE_PAGE_SIZE = 200;

/**
 * Radarr and Sonarr report time remaining as a .NET `TimeSpan`, whose "c"
 * format is `[d.]hh:mm:ss[.fffffff]` — the fraction appears whenever it is
 * non-zero, which is most of the time. Splitting on the first dot read
 * `00:04:32.1234567` as a day count of `00:04:32` and gave up, so the download
 * came back with no ETA at all.
 */
const TIMESPAN = /^(?:(\d+)\.)?(\d+):(\d+):(\d+)(?:\.\d+)?$/;

export function parseTimeleft(value: string | undefined): number | undefined {
    const parts = value === undefined ? null : TIMESPAN.exec(value.trim());
    if (parts === null) return undefined;
    return Number(parts[1] ?? 0) * 86_400 + Number(parts[2]) * 3600 + Number(parts[3]) * 60 + Number(parts[4]);
}

export async function readArrQueue(http: ServiceHttp, service: string): Promise<QueueItem[]> {
    const records: RawQueueRecord[] = [];
    for (let page = 1; ; page++) {
        const body = await http.get<RawQueuePage>(`/api/v3/queue?page=${page}&pageSize=${QUEUE_PAGE_SIZE}`);
        const got = body.records ?? [];
        records.push(...got);
        // An empty page ends it whatever the count says: a service that
        // disagrees with its own `totalRecords` must not spin here.
        if (got.length === 0 || body.totalRecords === undefined || records.length >= body.totalRecords) break;
    }

    return records
        .filter((r): r is RawQueueRecord & { id: number } => typeof r.id === 'number')
        .map(r => {
            const eta = parseTimeleft(r.timeleft);
            return {
                service,
                id: String(r.id),
                title: fenceText(r.title ?? '', { service, field: 'title' }),
                status: r.status ?? 'unknown',
                ...(r.protocol === undefined ? {} : { protocol: r.protocol }),
                ...(r.size === undefined ? {} : { sizeBytes: r.size }),
                ...(r.sizeleft === undefined ? {} : { remainingBytes: r.sizeleft }),
                ...(eta === undefined ? {} : { etaSeconds: eta }),
                ...(r.errorMessage ? { errorMessage: fenceText(r.errorMessage, { service, field: 'errorMessage' }) } : {})
            };
        });
}

/**
 * Shared for the same reason the read above is: Radarr and Sonarr expose the
 * identical `DELETE /api/v3/queue/{id}` with the identical two flags. Writing
 * it twice is how the two drift into disagreeing about what `blocklist` means.
 */
export async function removeArrQueueItem(
    http: ServiceHttp,
    service: string,
    id: string,
    opts: RemoveQueueOptions
): Promise<void> {
    const numeric = Number(id);
    if (!Number.isInteger(numeric)) {
        throw new ServiceError('NotFound', service, `"${id}" is not a ${service} queue id`, {
            remedy: 'Queue ids are integers on Radarr and Sonarr. Take one from get_queue.'
        });
    }

    // Both flags are serialised explicitly rather than omitted when false:
    // Radarr defaults `removeFromClient` to true, so leaving it out on a
    // remove-from-*arr-only request would also wipe it from the download
    // client — the opposite of what was asked for.
    await http.delete(
        `/api/v3/queue/${numeric}?removeFromClient=${String(opts.removeFromClient)}&blocklist=${String(opts.blocklist)}`
    );
}

/** Radarr's `/movie/{id}`, Sonarr's `/series/{id}` — same flags, different noun. */
export async function deleteArrMedia(
    http: ServiceHttp,
    service: string,
    resource: 'movie' | 'series',
    id: string,
    opts: DeleteMediaOptions
): Promise<void> {
    const numeric = Number(id);
    if (!Number.isInteger(numeric)) {
        throw new ServiceError('NotFound', service, `"${id}" is not a ${service} ${resource} id`, {
            remedy: `${service} ids are integers. Get one from get_media_details or get_library.`
        });
    }

    await http.delete(
        `/api/v3/${resource}/${numeric}?deleteFiles=${String(opts.deleteFiles)}&addImportExclusion=${String(opts.addImportExclusion)}`
    );
}

type RawCalendarMovie = {
    id?: number;
    title?: string;
    inCinemas?: string;
    physicalRelease?: string;
    digitalRelease?: string;
    hasFile?: boolean;
    monitored?: boolean;
};

/**
 * A film has up to three dates, and the useful one is the earliest you could
 * actually watch it: digital, then physical, then cinema. A row with none of
 * the three is dropped — an undated calendar entry is noise.
 */
export function readRadarrCalendar(movies: RawCalendarMovie[], service: string): CalendarEntry[] {
    return movies
        .filter((m): m is RawCalendarMovie & { id: number } => typeof m.id === 'number')
        .map(m => ({ m, date: m.digitalRelease ?? m.physicalRelease ?? m.inCinemas }))
        .filter((row): row is { m: RawCalendarMovie & { id: number }; date: string } => typeof row.date === 'string')
        .map(({ m, date }) => ({
            service,
            kind: 'movie' as const,
            id: m.id,
            title: fenceText(m.title ?? '', { service, field: 'title' }),
            date,
            hasFile: m.hasFile ?? false,
            monitored: m.monitored ?? false
        }));
}

type RawCalendarEpisode = {
    id?: number;
    title?: string;
    seasonNumber?: number;
    episodeNumber?: number;
    airDateUtc?: string;
    hasFile?: boolean;
    monitored?: boolean;
    series?: { title?: string };
};

export function readSonarrCalendar(episodes: RawCalendarEpisode[], service: string): CalendarEntry[] {
    return episodes
        .filter(
            (e): e is RawCalendarEpisode & { id: number; airDateUtc: string } =>
                typeof e.id === 'number' && typeof e.airDateUtc === 'string'
        )
        .map(e => ({
            service,
            kind: 'episode' as const,
            id: e.id,
            title: fenceText(e.title ?? '', { service, field: 'title' }),
            ...(e.series?.title === undefined
                ? {}
                : { seriesTitle: fenceText(e.series.title, { service, field: 'series.title' }) }),
            ...(e.seasonNumber === undefined ? {} : { season: e.seasonNumber }),
            ...(e.episodeNumber === undefined ? {} : { episode: e.episodeNumber }),
            date: e.airDateUtc,
            hasFile: e.hasFile ?? false,
            monitored: e.monitored ?? false
        }));
}

export const calendarPath = (range: { start: Date; end: Date }): string =>
    `/api/v3/calendar?start=${range.start.toISOString()}&end=${range.end.toISOString()}`;

/**
 * Sonarr omits the series object from calendar rows unless asked, so
 * `seriesTitle` came back empty for every episode — an episode calendar that
 * cannot say which series an episode belongs to is close to useless. Confirmed
 * against a live Sonarr 4.0.19 during a live capture.
 */
export const sonarrCalendarPath = (range: { start: Date; end: Date }): string =>
    `${calendarPath(range)}&includeSeries=true`;
