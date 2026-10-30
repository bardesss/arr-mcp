import { fenceText } from "../core/fence.ts";
import type { ServiceHttp } from "../core/http.ts";
import type { DownloadTrace } from "./types.ts";

type RawTraceRecord = {
  eventType?: string;
  date?: string;
  sourceTitle?: string;
  downloadId?: string;
  movieId?: number;
  seriesId?: number;
  episodeId?: number;
};

type Page = { records?: RawTraceRecord[] };

const PAGE = "page=1&pageSize=50&sortKey=date&sortDirection=descending";
// The `eventType` filter value for a grab, the same in both services.
const GRABBED_CODE = 1;

const time = (date: string | undefined): number =>
  date === undefined ? Number.NaN : Date.parse(date);

/**
 * What a Radarr or Sonarr did with one download id: whether it marked the
 * download failed, and whether it then grabbed (and imported) a replacement
 * for the same media. One page of 50 records per read is deliberate.
 */
export async function traceArrDownload(
  http: ServiceHttp,
  service: string,
  kind: "movie" | "series",
  downloadId: string,
): Promise<DownloadTrace | undefined> {
  const fence = (value: string, field: string) =>
    fenceText(value, { service, field });
  const read = async (query: string): Promise<RawTraceRecord[]> =>
    (await http.get<Page>(`${http.apiRoot}/history?${query}&${PAGE}`))
      .records ?? [];

  // The service matches `downloadId` loosely on some builds; keep only exact ones.
  const own = (
    await read(`downloadId=${encodeURIComponent(downloadId)}`)
  ).filter((r) => r.downloadId === undefined || r.downloadId === downloadId);
  if (own.length === 0) return undefined;

  const grab = own.find((r) => r.eventType === "grabbed") ?? own[0];
  const title = fence(grab?.sourceTitle ?? "", "sourceTitle");
  const failed = own.find((r) => r.eventType === "downloadFailed");
  if (failed === undefined) return { service, title };

  const failedAt = failed.date;
  const trace: DownloadTrace = {
    service,
    title,
    ...(failedAt === undefined ? {} : { failedAt }),
  };
  const failedTime = time(failedAt);

  const mediaOf = (r: RawTraceRecord) =>
    kind === "movie" ? r.movieId : r.seriesId;
  const mediaId =
    mediaOf(failed) ?? own.map(mediaOf).find((id) => id !== undefined);
  if (mediaId === undefined || Number.isNaN(failedTime)) return trace;

  const episodes = new Set(
    own.map((r) => r.episodeId).filter((id): id is number => id !== undefined),
  );
  const scoped = kind === "movie" ? "movieIds" : "seriesIds";
  const later = (await read(`${scoped}=${mediaId}&eventType=${GRABBED_CODE}`))
    .filter(
      (r) =>
        r.eventType === "grabbed" &&
        r.downloadId !== undefined &&
        r.downloadId !== downloadId &&
        time(r.date) > failedTime &&
        (kind === "movie" ||
          episodes.size === 0 ||
          (r.episodeId !== undefined && episodes.has(r.episodeId))),
    )
    .sort((a, b) => time(b.date) - time(a.date));

  // Several records can share a download id (a season pack); the newest is enough.
  const next = later[0];
  if (next?.downloadId === undefined || next.date === undefined) return trace;

  const imported = (
    await read(`downloadId=${encodeURIComponent(next.downloadId)}`)
  ).some((r) => r.eventType === "downloadFolderImported");
  return {
    ...trace,
    replacement: {
      title: fence(next.sourceTitle ?? "", "sourceTitle"),
      grabbedAt: next.date,
      imported,
    },
  };
}
