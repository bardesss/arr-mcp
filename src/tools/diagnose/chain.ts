import { DOWNLOAD_CLIENTS, type ServiceId } from '../../config/schema.ts';
import { servicesOnly } from '../../core/gather.ts';
import { instantOf } from '../../core/instant.ts';
import type { NextStep } from '../../core/nextStep.ts';
import { unfenced } from '../../core/titleMatch.ts';
import { ARR_KIND, ARR_NAMES, SEERR_ARR, seerrMediaType, type MergedItem } from '../../core/resolver.ts';
import { fenceText } from '../../core/fence.ts';
import { isLidarrRow, PENDING_STATUSES, usenetRerun } from '../../services/arrRecord.ts';
import type {
    AlbumSummary,
    CleanupRemoval,
    CleanupStatus,
    HistoryEntry,
    IndexerRejection,
    QueueItem,
    RequestStatus,
    ScanState,
    DownloadStrikes,
    SubtitleGap
} from '../../services/types.ts';
import { removalSentence, upcomingSentence } from '../cleanupStatus.ts';
import { importFailing, importStepFor, needsMapping, orphanImportStepFor, retriedImportStepFor } from '../importStep.ts';
import { instanceArgs } from '../resolveInstance.ts';

type Stage = 'resolve' | 'request' | 'managed' | 'file' | 'queue' | 'indexers' | 'library' | 'scan' | 'subtitles';
/** `warning` is worth a look but blocks nothing. */
type StepStatus = 'ok' | 'warning' | 'blocked' | 'unknown' | 'skipped';

export type Step = { stage: Stage; service?: string; status: StepStatus; detail: string };

/**
 * `undefined` and `null` mean different things throughout, and the distinction
 * is the whole of **undefined is "could not look", null is "looked and
 * found nothing"**. Collapsing them is how a diagnosis becomes confidently
 * wrong about a service that was down.
 */
export type Evidence = {
    item: MergedItem | undefined;
    /**
     * Set when `item.kind` is a stand-in: a media server named by id reports
     * no kind (Jellyfin's `item`), so `movie` is used. Every *arr then counts
     * as one that could hold it, Lidarr aside for an item that carries a film
     * or series id (`couldManage`).
     */
    itemKindGuessed?: true;
    /**
     * `id` is Seerr's own request id, the one `respond_to_request` takes.
     * `mayRespond` is whether that tool's own check would let the caller act on
     * it (their request, or `allow_other_users`); absent reads as no, so a
     * request whose owner is unknown gets no approval or retry offered.
     */
    request: { status: RequestStatus | 'unknown'; id?: number; mayRespond?: boolean } | null | undefined;
    /**
     * `items` is what the collector actually read, `partial` names the clients
     * that did not answer. One unreachable client used to erase the whole stage,
     * discarding rows another client did return, including the stalled row that
     * was the cause. `undefined` still means every client failed.
     */
    queue: { items: QueueItem[]; partial: string[] } | undefined;
    /** Analogue of `mediaServer !== undefined`: no download client at all, not merely unreachable. */
    queueConfigured: boolean;
    rejections: IndexerRejection[] | undefined;
    /** Analogue of `mediaServer !== undefined`: no Prowlarr configured, not merely unreachable. */
    prowlarrConfigured: boolean;
    /** The Prowlarr instances whose rejection read failed. Named rather than a
     *  boolean: the stage has to say which half of the answer is missing. */
    prowlarrDegraded: string[];
    /**
     * The enabled indexers across every Prowlarr, as `indexerKey`s, and those of
     * them Prowlarr has disabled for now after failures. Read only when a
     * rejection mentions the item, to weigh how many are out. Absent when not read
     * or when any Prowlarr's list could not be (`<prowlarr>:indexers` in `degraded`).
     */
    indexers?: { enabled: string[]; disabled: string[] };
    scan: ScanState | undefined;
    /**
     * A third state beyond looked/could-not-look: **never configured**. Without
     * it, a stack with no media server gets "Jellyfin cannot see it", a claim
     * about a service the user does not run.
     *
     * The configured media server's id, absent when none is configured;
     * the stages need the name, not just whether one exists.
     */
    mediaServer?: string;
    /** Whether that media server can report scan state at all. */
    scanCapable: boolean;
    /** Cleanuparr events for this item's downloads, newest first. null: not configured. */
    cleanuparr: HistoryEntry[] | null | undefined;
    /** Cleanuparr's standing strikes on this item's downloads. null: not configured; undefined: could not look. */
    strikes?: DownloadStrikes[] | null | undefined;
    /**
     * Every gap Bazarr lists, not yet narrowed to this item: nothing maps a
     * Bazarr to its *arr, so the match (id and title) is the chain's. Read only
     * for an item with a file. null: not configured. undefined: could not look.
     */
    subtitles?: { gaps: SubtitleGap[]; service: string } | null | undefined;
    /** Reclaimerr's view of this title: candidates, protections, removals. null: not configured. */
    cleanup?: CleanupStatus | null | undefined;
    /** The cleanup service that was configured but could not be read, so a missing file's cause is unknown. */
    cleanupUnread?: string;
    /** The managing *arr's latest import of this item, read only when there is a removal to weigh it against. */
    lastImportAt?: string;
    /**
     * An artist's albums, read only when it has no track on disk, because a
     * search for it grabs only releases of a monitored album. `truncated` when
     * the list stopped at 500. Absent when not read; a failed read is
     * `<lidarr>:albums` in `degraded`.
     */
    albums?: { list: AlbumSummary[]; truncated: boolean };
    /**
     * Download-history rows whose release name matches the query, read only
     * when the query resolved to nothing: an item removed from Radarr whose
     * torrent Cleanuparr then cleaned is in no library, only in history.
     * Absent when it was not read; a source that failed is in `degraded`.
     */
    history?: HistoryEntry[];
    /**
     * Library-read reachability, separate from `degraded` below, which is
     * *probe* reachability. A service can fail one without the other: a failing
     * `getScanState` on the media server must not erase a library read that
     * succeeded, and a failing Radarr library read must not make `queueStep`
     * call every queue unknown. Only `libraryStep`, and the `managed` check
     * for an item no *arr claims, read this; every other step reads
     * `degraded`.
     */
    libraryDegraded: readonly string[];
    degraded: readonly string[];
    /**
     * The *arr instances configured here (`radarr`, `sonarr/4k`, ...), so a
     * remedy for an item nothing manages names only the *arrs this stack runs.
     */
    arrs: readonly string[];
};

export type Diagnosis = {
    query: string;
    resolved?: { title: string; year?: number; kind: MergedItem['kind']; ids: MergedItem['ids'] };
    steps: Step[];
    /**
     * `next_steps` is the call that would act on `remedy`, as data. Offered, never
     * run here; absent when the fix is not a call this server can make.
     */
    verdict: { stage: Stage | 'playable'; summary: string; remedy?: string; next_steps?: NextStep[]; certain: boolean };
    /** Unresolved queries only: the row that explains each matching release, newest first. */
    history?: HistoryEntry[];
    degraded: string[];
};

/** Reported in this order; it is the order the pipeline actually runs in. */
const DISPLAY_ORDER: readonly Stage[] = [
    'resolve',
    'request',
    'managed',
    'file',
    'queue',
    'indexers',
    'library',
    'scan',
    // Last because it never changes the verdict: a title plays without subtitles.
    'subtitles'
];

const SKIPPED = (stage: Stage, detail: string): Step => ({ stage, status: 'skipped', detail });

/** Splits on runs of non-alphanumerics, the way a release name's dots and
 *  dashes are. Both sides of `mentions` must tokenise identically, or
 *  `normaliseTitle` deleting punctuation and a haystack splitting on it never
 *  produce the same tokens. */
const tokenize = (value: string): string[] =>
    value
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(w => w.length > 0);

const LEADING_ARTICLE = new Set(['the', 'a', 'an']);

/** Item-title tokens only: a release name legitimately keeping "The" as a word must still be able to satisfy a title that dropped it (`words` is checked as a subset of the haystack, so extra haystack tokens are harmless either way). */
const titleWords = (item: MergedItem): string[] => {
    const words = tokenize(unfenced(item.title));
    return words.length > 1 && LEADING_ARTICLE.has(words[0] as string) ? words.slice(1) : words;
};

/**
 * Whether a release name plausibly refers to `item`. Three failure modes it
 * guards against, each of which has happened:
 *
 * - **Substring matching.** "Alien" is inside "Aliens", "Dune" inside
 *   "Dune.Part.Two". Whole tokenised words close the first; a contradicting
 *   year closes the second.
 * - **A length filter starves short titles.** "Up", "Se7en" and "Top Gun" have
 *   no word over three characters, so dropping short words left nothing to
 *   match. Every word counts, however short.
 * - **Deleting punctuation on one side, splitting on the other.**
 *   `normaliseTitle` deletes it ("Spider-Man" → "spiderman") while a release
 *   name splits on it ("Spider.Man.2002" → spider, man, 2002), so neither ever
 *   produced the same tokens. `tokenize` splits both sides identically.
 */
export const mentions = (haystack: string, item: MergedItem): boolean => {
    const words = titleWords(item);
    if (words.length === 0) return false;

    // The needle is unfenced before tokenising, so the haystack must be too;
    // otherwise the fence markers themselves become haystack tokens.
    const hayWords = tokenize(unfenced(haystack));
    const haySet = new Set(hayWords);
    if (!words.every(w => haySet.has(w))) return false;

    // A series release's year is the episode's, not the show's start year:
    // "The.Simpsons.S32E01.2020" is no mismatch for a show that began in 1989.
    // Skip the guard entirely for series.
    if (item.kind !== 'series' && item.year !== undefined) {
        // A year inside the title itself ("2049", "1917", "2001") is not
        // *the release's* year, and the word match above already accounted for
        // it. Only a year-shaped token that is not one of the title's own
        // words counts.
        const wordSet = new Set(words);
        const yearInHay = hayWords.find(w => /^(19|20)\d{2}$/.test(w) && !wordSet.has(w));
        if (yearInHay !== undefined && Number(yearInHay) !== item.year) return false;
    }

    return true;
};

const YEAR_TOKEN = /^(19|20)\d{2}$/;

/** `s04e03`, `s04` or `4x03`, as `tokenize` leaves them. */
function episodeOf(token: string): { season: number; episode?: number } | undefined {
    const m = /^(?:s(\d{1,3})(?:e(\d{1,4}))?|(\d{1,2})x(\d{1,3}))$/.exec(token);
    if (m === null) return undefined;
    const episode = m[2] ?? m[4];
    return { season: Number(m[1] ?? m[3]), ...(episode === undefined ? {} : { episode: Number(episode) }) };
}

const withoutArticle = (words: string[]): string[] =>
    words.length > 1 && LEADING_ARTICLE.has(words[0] as string) ? words.slice(1) : words;

/**
 * Whether a release name is plausibly what a person asked for, when there is
 * no library item to compare against (the history fallback below). The query
 * is read the way the resolver reads one: title words, then an optional bare
 * year, then an optional episode ("Shogun 2024 S01E03").
 *
 * Stricter than `mentions` in one way: the title words must *lead* the release
 * name, as they do in every scene name, so "Office" cannot match
 * "Something.About.The.Office". A year or episode the query names must not be
 * contradicted by the release; a release that names neither is not a
 * contradiction, and a season pack matches any episode of its season.
 */
export const releaseMentions = (haystack: string, query: string): boolean => {
    let words = tokenize(unfenced(query));
    const asked = words.length > 1 ? episodeOf(words.at(-1) as string) : undefined;
    if (asked !== undefined) words = words.slice(0, -1);
    // Not for a one-word query: "1917" is a title, not a year.
    const year = words.length > 1 && YEAR_TOKEN.test(words.at(-1) as string) ? words.at(-1) : undefined;
    if (year !== undefined) words = words.slice(0, -1);
    words = withoutArticle(words);
    if (words.length === 0) return false;

    const hay = withoutArticle(tokenize(unfenced(haystack)));
    if (!words.every((w, i) => hay[i] === w)) return false;
    const rest = hay.slice(words.length);

    if (year !== undefined) {
        const years = rest.filter(w => YEAR_TOKEN.test(w));
        if (years.length > 0 && !years.includes(year)) return false;
    }
    if (asked !== undefined) {
        const found = rest.map(episodeOf).filter(e => e !== undefined);
        const same = found.some(e => e.season === asked.season && (asked.episode === undefined || e.episode === undefined || e.episode === asked.episode));
        if (!same) return false;
    }
    return true;
};

/** Releases named in the summary; the rest are in `history`. */
const HISTORY_RELEASES_SHOWN = 3;

/** How a delete an *arr reported to the event log is worded, by its webhook event name. */
const REPORTED_DELETE: Record<string, string> = {
    MovieDelete: 'deleting',
    SeriesDelete: 'deleting',
    MovieFileDelete: 'deleting the file of',
    EpisodeFileDelete: 'deleting the file of'
};

/**
 * One sentence per release for the history fallback. Cleanuparr removing or
 * stopping it is the answer when it did; a client's own outcome otherwise. A
 * delete the *arr reported comes next, because that is why it has no record.
 */
function releaseSentence(rows: readonly HistoryEntry[]): { row: HistoryEntry; said: string } {
    const removals = rows.filter(e => e.service === 'cleanuparr' && (e.event === 'deleted' || e.event === 'stopped'));
    const acted = removals.find(e => e.dryRun !== true) ?? removals[0];
    if (acted !== undefined) {
        const verb = acted.event === 'deleted' ? 'removed' : 'stopped';
        const why = acted.reason === undefined ? '' : `: ${acted.reason}`;
        const counts = rows.filter(e => e.event === 'strike').map(e => e.strikeCount ?? 0);
        const strikeCount = acted.strikeCount ?? (counts.length === 0 ? undefined : Math.max(...counts));
        const strikes = strikeCount === undefined || strikeCount === 0 ? '' : `, after ${strikeCount} strikes`;
        const said =
            acted.dryRun === true
                ? `Cleanuparr would have ${verb} ${acted.title} on ${acted.at.slice(0, 10)}${why} (dry run, nothing was done).`
                : `Cleanuparr ${verb} ${acted.title} on ${acted.at.slice(0, 10)}${why}${strikes}.`;
        return { row: acted, said };
    }
    const reported = rows.find(e => e.rawEvent !== undefined && Object.hasOwn(REPORTED_DELETE, e.rawEvent));
    if (reported !== undefined) {
        const why = reported.reason === undefined ? '' : `: ${reported.reason}`;
        return { row: reported, said: `${reported.service} reported ${REPORTED_DELETE[reported.rawEvent as string]} ${reported.title} on ${reported.at.slice(0, 10)}${why}.` };
    }
    const row = rows[0] as HistoryEntry;
    if (row.service === 'cleanuparr' && row.event === 'strike') {
        const count = row.strikeCount === undefined ? '' : ` ${row.strikeCount} times`;
        return { row, said: `Cleanuparr struck ${row.title}${count}${STRIKE_KIND[(row.rawEvent ?? '').replace(/Strike$/u, '')] ?? ''}, last on ${row.at.slice(0, 10)}.` };
    }
    const what = row.event === 'imported' ? 'completed' : row.event === 'failed' || row.event === 'deleted' ? row.event : `logged ${row.rawEvent ?? row.event} for`;
    const why = row.reason === undefined ? '' : `: ${row.reason}`;
    return { row, said: `${row.service} ${what} ${row.title} on ${row.at.slice(0, 10)}${why}.` };
}

/** Rows newest first, grouped by download, most recently active release first. */
function releasesOf(rows: readonly HistoryEntry[]): HistoryEntry[][] {
    const groups = new Map<string, HistoryEntry[]>();
    for (const row of [...rows].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))) {
        const key = row.downloadId ?? `${row.service}:${unfenced(row.title).toLowerCase()}`;
        groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    return [...groups.values()];
}

function requestStep(ev: Evidence, item: MergedItem): Step {
    // Not read for an artist at all, so `null` would otherwise say "no request
    // recorded" about a service that was never asked.
    if (item.kind === 'artist') return SKIPPED('request', 'Seerr does not handle music, so there is no request to check.');
    // True both when Seerr itself could not be reached and when it answered
    // but the item had no tmdb id to match against (evidence.ts); the
    // wording has to hold in both cases rather than asserting an outage that
    // may not have happened.
    if (ev.request === undefined) {
        return { stage: 'request', service: 'seerr', status: 'unknown', detail: 'Could not determine whether this was requested.' };
    }
    if (ev.request === null) return SKIPPED('request', 'No request recorded. Not everything arrives through Seerr.');

    if (ev.request.status === 'declined') {
        return { stage: 'request', service: 'seerr', status: 'blocked', detail: 'The request was declined.' };
    }
    if (ev.request.status === 'pending') {
        return { stage: 'request', service: 'seerr', status: 'blocked', detail: 'The request is still awaiting approval.' };
    }
    if (ev.request.status === 'failed') {
        return {
            stage: 'request',
            service: 'seerr',
            status: 'blocked',
            detail: 'Seerr approved the request but could not hand it to Radarr or Sonarr.'
        };
    }
    if (ev.request.status === 'unknown') {
        // Seerr answered, but not with a status this module recognises.
        // Reporting that as `ok`
        // ("The request is unknown.") would be green on a request that never
        // went anywhere.
        return {
            stage: 'request',
            service: 'seerr',
            status: 'blocked',
            detail: 'Seerr reports the request in an indeterminate state. It may have failed to submit.'
        };
    }
    return { stage: 'request', service: 'seerr', status: 'ok', detail: `The request is ${ev.request.status}.` };
}

/**
 * An explicit set, not a regex over free text. `/stall|fail|error|paused/i`
 * reads `completed` (a download waiting to be imported, which is exactly the
 * broken import this tool exists to surface) as "still downloading", because
 * "complete" contains none of those substrings. It misreads
 * `downloadClientUnavailable` and `warning`/`delay` the same way.
 *
 * The vocabulary is what the adapters actually emit, lowercased. `seeding`,
 * qBittorrent's `seeding (no peers)` and `queued to seed` mean the file is
 * fully on disk, so they are import-pending rather than active; `propagating`
 * is SABnzbd finalising a healthy download, so it stays active, as do
 * qBittorrent's `fetching metadata` and `allocating`.
 */
const QUEUE_ACTIVE = new Set([
    'downloading',
    'queued',
    'queued to verify',
    'verifying',
    'fetching',
    'fetching metadata',
    'allocating',
    'checking',
    'extracting',
    'repairing',
    'moving',
    'grabbing',
    'propagating'
]);

const QUEUE_IMPORT_PENDING = new Set(['completed', 'seeding', 'seeding (no peers)', 'queued to seed']);
export const SEEDING = new Set(['seeding', 'seeding (no peers)', 'queued to seed']);

/**
 * A download with a warning: qBittorrent's `stalled`, `error` and
 * `missing files`, and the *arrs' `warning`. The *arrs give `warning` to those,
 * to Transmission's error string, and to a full disk while unpacking or a
 * failed move (`QBittorrent`, `TransmissionBase`, `Sabnzbd`, `Nzbget`).
 */
const QUEUE_WARNING = new Set(['warning', 'stalled', 'error', 'missing files']);

/** Stopped in the client: paused before it finished, or a torrent that finished and stopped seeding. */
const QUEUE_STOPPED = new Set(['paused', 'stopped']);

const isClientRow = (row: QueueItem): boolean => (DOWNLOAD_CLIENTS as readonly string[]).includes(instanceArgs(row.service).service);

/**
 * A torrent stopped with nothing left to download (`torrent.seeding`), as at a
 * seed limit: finished, not paused. A size of 0 is a magnet with no metadata
 * yet, which has nothing left only because it knows of nothing (Radarr reads it
 * as queued, `TransmissionBase`).
 */
const stoppedFinished = (row: QueueItem): boolean =>
    QUEUE_STOPPED.has(row.status.toLowerCase()) && row.torrent?.seeding === true && (row.sizeBytes ?? 0) > 0;

/** The whole file is in the client: seeding, or stopped after it finished. */
const onDisk = (row: QueueItem): boolean => SEEDING.has(row.status.toLowerCase()) || stoppedFinished(row);

/** Every byte is down: on disk in the client, or a row of some size with nothing left to download. */
const complete = (row: QueueItem): boolean => onDisk(row) || (row.remainingBytes === 0 && (row.sizeBytes ?? 0) > 0);

type QueueClass = 'failed' | 'warning' | 'unrecognised' | 'importPending' | 'unavailable' | 'paused' | 'held' | 'active' | 'indeterminate';

/**
 * Anything not recognised is `unrecognised`, and blocks like a fault: silence
 * is not evidence of health.
 *
 * One exception. The literal `"unknown"` is not something a download client
 * reports; it is our own adapters' fallback for a status code they could not
 * map. That is the service saying something unclassifiable, so it is
 * `indeterminate` rather than a fault.
 *
 * A message alone decides nothing on an *arr's row: the *arrs say `warning` or
 * `failed` themselves when it is trouble, and carry others on a download on its
 * way or finished ("qBittorrent is downloading metadata", `QBittorrent`;
 * NZBGet's PAR status, `Nzbget`). A download client's row carries one only when
 * something is wrong (Transmission's error string, which the *arrs read as
 * `warning`).
 *
 * `PENDING_STATUSES` are releases the *arr holds and has sent to no client:
 * `downloadClientUnavailable` failed to reach one, and the rest wait (a delay
 * profile, a usenet minimum age or another of the `Temporary` rejections).
 */
export function classifyQueueStatus(item: QueueItem): QueueClass {
    const status = item.status.toLowerCase();
    if (status === 'failed') return 'failed';
    if (QUEUE_WARNING.has(status) || (item.errorMessage !== undefined && isClientRow(item))) return 'warning';
    if (QUEUE_IMPORT_PENDING.has(status) || stoppedFinished(item)) return 'importPending';
    if (status === 'downloadclientunavailable') return 'unavailable';
    if (QUEUE_STOPPED.has(status)) return 'paused';
    if (PENDING_STATUSES.has(status)) return 'held';
    if (QUEUE_ACTIVE.has(status)) return 'active';
    if (status === 'unknown') return 'indeterminate';
    return 'unrecognised';
}

/**
 * Priority order when more than one row in the same queue matches the item:
 * what is broken first (a failed download, one in trouble, a state this module
 * does not know), then an unimported completion, then a release the *arr could
 * not send, then what is waiting (paused, held, still downloading), then a
 * status the adapter itself could not map (`unknown`). Within one of those, the
 * *arr's row comes before a client's: its removal can blocklist, and while the
 * *arr lists a grab it has not imported it, whatever a seeding client row and
 * `hasFile` (any track, on an artist) suggest.
 */
const QUEUE_CLASS_PRIORITY: readonly QueueClass[] = [
    'failed',
    'warning',
    'unrecognised',
    'importPending',
    'unavailable',
    'paused',
    'held',
    'active',
    'indeterminate'
];

function pickQueueRow(mine: readonly QueueItem[]): { row: QueueItem; cls: QueueClass } {
    for (const cls of QUEUE_CLASS_PRIORITY) {
        const rows = mine.filter(q => classifyQueueStatus(q) === cls);
        const row = rows.find(q => !isClientRow(q)) ?? rows[0];
        if (row !== undefined) return { row, cls };
    }
    // Unreachable: classifyQueueStatus always returns one of the classes
    // above, and every call site already checked `mine.length > 0`.
    const row = mine[0] as QueueItem;
    return { row, cls: classifyQueueStatus(row) };
}

/**
 * What the item's own *arr is called in a remedy: the one that manages it, so a
 * stack running only Radarr is not told about a Sonarr. A queue remedy is the
 * verdict only when something manages the item (otherwise `buildChain` stops at
 * `request` or `managed`), so the other names are a fallback.
 */
function arrOf(item: MergedItem): string {
    const managing = item.acquisition === undefined ? undefined : ARR_NAMES[instanceArgs(item.acquisition.service).service];
    if (managing !== undefined) return managing;
    return item.kind === 'artist' ? 'Lidarr' : 'Radarr/Sonarr';
}

const queueFaultRemedy = (item: MergedItem): string =>
    `Check the download client for the failed grab: retry it, remove it, or fix what it reports (e.g. connectivity to the indexer or news server), then let ${arrOf(item)} search again.`;
/**
 * A warning that may be a stall, which can clear by itself: qBittorrent's
 * `stalled`, and the *arrs' `warning`, which they give one too (`QBittorrent`).
 * `said` is the row that says most: the client's own, when the grab has one.
 */
const MAY_STALL = new Set(['stalled', 'warning']);
const queueWarningRemedy = (item: MergedItem, said: QueueItem): string =>
    MAY_STALL.has(said.status.toLowerCase())
        ? `A stalled torrent often finishes later, so waiting may be enough; otherwise fix what the client reports, or remove the download and let ${arrOf(item)} search again.`
        : `Fix what the client reports, or remove the download and let ${arrOf(item)} search again.`;
/**
 * A client's row cannot be blocklisted; when the *arr lists the grab too, its
 * own queue row can. The step offered removes the client's row, so the text
 * names the *arr's row and its instance.
 */
const queueClientWarningRemedy = (item: MergedItem, said: QueueItem, arrRow: QueueItem): string =>
    `${queueWarningRemedy(item, said)} To blocklist a bad release, remove it from ${arrRow.service}’s queue with remove_queue_item, \`id\` "${arrRow.id}" and \`blocklist: true\`.`;
const queueUnrecognisedRemedy = (item: MergedItem): string =>
    `Check the download in the download client and fix what it reports, or remove it and let ${arrOf(item)} search again.`;
/** For a state this module does not know, whose finished files keep the removal back. */
const QUEUE_UNRECOGNISED_KEPT_REMEDY = 'Check the download in the download client and fix what it reports.';
const queueImportRemedy = (item: MergedItem): string =>
    `The download finished but has not been imported yet. Check ${arrOf(item)}’s activity/history for why, then trigger the import manually if it did not run on its own.`;
/** `importBlocked`: the *arr tried, stopped, and does not try again by itself. */
const queueImportBlockedRemedy = (item: MergedItem): string =>
    `${arrOf(item)} stopped before importing it and does not retry on its own. Fix what it reports, then trigger the import manually; a release it matched wrongly fails the same way until that is fixed in ${arrOf(item)}.`;
/**
 * `importPending` with reasons: the *arr tried, could not, and tries again
 * each cycle with the same result. A live Sonarr 4.0.20 reports a download with
 * no importable file this way ("No files found are eligible for import"), not
 * as `importBlocked`.
 */
const queueImportFailingRemedy = (item: MergedItem): string =>
    `${arrOf(item)} retries it on its own and fails the same way until what it reports is fixed there. The import's preview shows what it finds and why each file is refused; otherwise remove the download and let ${arrOf(item)} search again.`;
/** Importing already, but with reasons on the row, which an import by hand would meet too. */
const queueImportingRemedy = (item: MergedItem): string =>
    `Wait for ${arrOf(item)} to import it. If it stays here, fix what it reports in ${arrOf(item)}: an import by hand meets the same reasons.`;

/** The *arr's states in which it is importing the download, or just has: an import by hand only races it. */
const IMPORTING = new Set(['importPending', 'importing', 'imported']);

/** The *arr's own word on the import (`trackedDownloadState`), from its row in the grab. Absent when it sent none. */
const importStateOf = (grab: readonly QueueItem[]): string | undefined => grab.find(q => !isClientRow(q) && q.importState !== undefined)?.importState;

/** At most this many of the *arr's reasons go into a step; get_queue has them all. */
const REASONS_SHOWN = 3;

/**
 * The reasons the *arr gives on its row of the grab (`statusMessages`, already
 * fenced): why it will not import it, or what it warns about. A message that
 * only repeats the row's own is left out.
 */
function arrReasons(row: QueueItem, grab: readonly QueueItem[]): string {
    const arrRow = isClientRow(row) ? grab.find(q => !isClientRow(q) && q.statusMessages !== undefined) : row;
    const reasons = (arrRow?.statusMessages ?? []).filter(m => m !== row.errorMessage);
    if (arrRow === undefined || reasons.length === 0) return '';
    const more = reasons.length - REASONS_SHOWN;
    return ` ${arrRow.service} says: ${reasons.slice(0, REASONS_SHOWN).join('; ')}${more > 0 ? `; ${more} more in get_queue` : ''}.`;
}

/**
 * The *arrs read a download as paused while the client's whole queue is
 * (`Sabnzbd`, `Nzbget`; a SABnzbd one at Force priority aside), whatever the
 * client's own row says of it, and the adapter marks what holds it in
 * `heldBy`. Only a row the client itself pauses is resumed alone.
 */
const pausedInClient = (client: QueueItem): boolean => classifyQueueStatus(client) === 'paused';

/**
 * NZBGet's post-processing stages, as its adapter names them. The *arrs read a
 * download there as paused while its paused extra repair files are all that is
 * left (`Nzbget`), since NZBGet pauses them on add (`PrePostProcessor`).
 */
const NZBGET_POST_PROCESSING = new Set(['verifying', 'repairing', 'extracting', 'moving']);

/**
 * What starts a download the *arr reads as paused, from the client's own row
 * of the grab (the one paused itself, then one held, when there are two): the
 * download itself, the client's whole queue, both (the queue first, as the
 * step), or nothing, while the client post-processes it or another download,
 * waits on its own paused post-processing, or holds nothing back. A repair
 * NZBGet's paused queue and paused post-processing both hold gets the queue
 * step, and the remedy names post-processing too. A whole-queue resume is
 * offered only where the client says its queue holds the download, since
 * qBittorrent's resume without an id restarts every torrent.
 */
function pausedResume(grab: readonly QueueItem[]): { remedy: string; next?: NextStep } {
    const clients = grab.filter(isClientRow);
    const client = clients.find(pausedInClient) ?? clients.find(q => q.heldBy !== undefined) ?? clients[0];
    if (client === undefined) return { remedy: 'Resume it in the download client.' };
    const service = client.service;
    const resume = (id: string | undefined, why: string): NextStep => ({
        tool: 'pause_downloads',
        arguments: { ...instanceArgs(service), action: 'resume', ...(id === undefined ? {} : { id }) },
        why
    });
    const queueResume = `pause_downloads (\`action: "resume"\` without an \`id\`) on ${service}`;
    if (client.heldBy === 'postPaused') {
        return { remedy: `${service}'s post-processing is paused, so it waits there: resume post-processing in ${service}.` };
    }
    if (client.heldBy === 'queueAndPostPaused') {
        return {
            remedy: `${service}'s whole queue is paused and holds the repair files it asked for, and its post-processing is paused too: resume the queue with ${queueResume}, and post-processing in ${service} itself.`,
            next: resume(undefined, `Resumes ${service}'s whole queue; post-processing stays paused until it is resumed in ${service}.`)
        };
    }
    // A paused queue can hold the repair files a post-processing group still fetches (`queueHeld`).
    if (client.heldBy === undefined && instanceArgs(service).service === 'nzbget' && NZBGET_POST_PROCESSING.has(client.status)) {
        return { remedy: `${service} reports it as ${client.status}, a post-processing stage, and the *arr reads it as paused meanwhile: wait for it.` };
    }
    // SABnzbd's queue flag is also set while its "Pause Downloading During Post-Processing" switch waits on
    // post-processing, which a resume does not end (`Downloader.resume`) and its rows do not always show (`sabHolds`).
    const sabWait =
        instanceArgs(service).service === 'sabnzbd'
            ? ' (With its "Pause Downloading During Post-Processing" switch on, SABnzbd also pauses while it post-processes, and resumes by itself.)'
            : '';
    if (pausedInClient(client)) {
        return client.heldBy === 'queue'
            ? {
                  remedy: `It is paused in ${service}, and so is ${service}'s whole queue: resume the queue with ${queueResume}, then this download with \`id\` "${client.id}", or both in ${service} itself.${sabWait}`,
                  next: resume(undefined, `Resumes ${service}'s whole queue; this download stays paused until it is resumed with its \`id\`.`)
              }
            : {
                  remedy: `Resume it with pause_downloads (\`action: "resume"\` and its \`id\`) on ${service}, or in ${service} itself.`,
                  next: resume(client.id, `Resumes this one download in ${service}.`)
              };
    }
    if (client.heldBy === 'postProcessing') {
        return {
            remedy: `${service} pauses its queue while it post-processes (its "Pause Downloading During Post-Processing" switch), and resumes by itself: wait for it. If it stays paused, resume the queue with ${queueResume}.`
        };
    }
    if (client.heldBy === 'queue') {
        return {
            remedy: `${service}'s whole queue is paused and holds it: resume the queue with ${queueResume}, or in ${service} itself.${sabWait}`,
            next: resume(undefined, `Resumes ${service}'s whole queue.`)
        };
    }
    // Only a status this module knows as progress says nothing there holds it back.
    return classifyQueueStatus(client) === 'active'
        ? { remedy: `${service} reports it as ${client.status}, so nothing there is holding it back: check it in ${service} if it does not move on.` }
        : { remedy: `${service} reports it as ${client.status}: check it in ${service}.` };
}
const queueFinishedRemedy = (item: MergedItem): string =>
    `The download is complete, but the client reports a problem, and ${arrOf(item)} imports nothing while it stands. Fix it in the client (free disk space and retry the download, for one); ${arrOf(item)} imports it once the client no longer reports the problem.`;
/**
 * A usenet download the *arr marks with a warning after the client filed it in
 * its history (`usenetRerun`); the step's detail shows the message. It opens
 * with the *arr as the remedies beside it name it, and the removal names the
 * row's own instance, as `pausedResume` does, since this state offers no next
 * step that would carry it.
 */
const queueUsenetFinishedRemedy = (item: MergedItem, row: QueueItem): string =>
    `The client reports a problem, and ${arrOf(item)} imports nothing while it stands. ${usenetRerun(row, 'The message')}`;
/**
 * Only the *arr's row speaks for the torrent, and only its message tells
 * missing files from a finished download with a problem. The removal names the
 * row and its instance, since no next step in this state carries them.
 */
const queueUnconfirmedRemedy = (item: MergedItem, row: QueueItem): string =>
    `If the message says the files are missing, remove the download from ${row.service}’s queue with remove_queue_item and \`id\` "${row.id}", and let ${arrOf(item)} search again; otherwise fix what it reports, and it is imported once the warning clears.`;

/** The states that block with a remedy and offer the removal. */
type Trouble = 'failed' | 'warning' | 'unrecognised';
const TROUBLE: ReadonlySet<QueueClass> = new Set<Trouble>(['failed', 'warning', 'unrecognised']);
const isTrouble = (cls: QueueClass): cls is Trouble => TROUBLE.has(cls);

/** The services `queue` evidence can come from, so `degraded` folds into
 *  "could not fully look" the way `scan` and `indexers` already do. */
const QUEUE_SERVICES: readonly ServiceId[] = ['radarr', 'sonarr', 'whisparr', ...DOWNLOAD_CLIENTS];

/** Lidarr's queue is only read for an artist (evidence.ts), so only then does its being unreachable cost the queue stage anything. */
const queueServicesFor = (item: MergedItem): readonly ServiceId[] => (item.kind === 'artist' ? [...QUEUE_SERVICES, 'lidarr'] : QUEUE_SERVICES);

/**
 * The queue rows that belong to `item`. An id beats a title: a release can be
 * renamed past recognition, and a title can match another film's grab.
 *
 * Ids are only comparable within one instance, because `acquisition` keeps one
 * instance and a row from another instance of the same *arr numbers its media
 * independently. A client row has no media id of its own, so it takes the
 * verdict of the *arr row sharing its download id.
 */
/** What ties a client's row to the *arr's row for the same grab. */
const downloadKey = (row: QueueItem): string | undefined => (row.downloadId ?? row.torrent?.hash)?.toLowerCase();

export function queueRowsFor(rows: readonly QueueItem[], item: MergedItem): QueueItem[] {
    const acquisition = item.acquisition;
    const byId = (row: QueueItem): boolean | undefined =>
        row.mediaId !== undefined && acquisition?.id !== undefined && row.service === acquisition.service
            ? row.mediaId === acquisition.id
            : undefined;
    const keyOf = downloadKey;
    // An *arr that holds another kind never grabbed this item, so its rows go
    // before the title match ("Fargo.1996.1080p" is not the series), and so does
    // a client row tied to one. A second instance of the same kind keeps the title.
    const foreign = (row: QueueItem): boolean => {
        const holds = ARR_KIND[row.service.split('/')[0] ?? ''];
        return holds !== undefined && holds !== item.kind;
    };
    const claimed = new Map<string, QueueItem>();
    const foreignKeys = new Set<string>();
    for (const row of rows) {
        const key = keyOf(row);
        if (key === undefined) continue;
        if (foreign(row)) foreignKeys.add(key);
        else if (row.mediaId !== undefined && !claimed.has(key)) claimed.set(key, row);
    }
    return rows.filter(row => {
        if (foreign(row)) return false;
        const direct = byId(row);
        if (direct !== undefined) return direct;
        const key = row.mediaId === undefined ? keyOf(row) : undefined;
        if (key !== undefined && foreignKeys.has(key) && !claimed.has(key)) return false;
        const linked = key === undefined ? undefined : claimed.get(key);
        const verdict = linked === undefined ? undefined : byId(linked);
        // Only Lidarr's queue is read for an artist, so a client row that no
        // Lidarr row claims is a film's or someone else's, and an artist has no
        // year for the title match to be contradicted by ("Rush.2013.1080p").
        // An orphaned Lidarr row has no id to claim it by, so it keeps the title.
        if (item.kind === 'artist' && !isLidarrRow(row)) return verdict ?? (linked !== undefined && mentions(row.title, item));
        return verdict ?? mentions(row.title, item);
    });
}

type QueueResult = { step: Step; remedy?: string; next?: NextStep };

/** Keyed by Cleanuparr's strike kind; an event's type is its kind followed by `Strike`. */
const STRIKE_KIND: Record<string, string> = {
    Stalled: ' for stalling',
    FailedImport: ' for failed imports',
    SlowSpeed: ' for being slow',
    SlowTime: ' for being slow',
    DownloadingMetadata: ' for stuck metadata',
    DeadTorrent: ' as a dead torrent',
    Errored: ' for a client error'
};

/** Only a strike on this row's own download counts. */
function strikeNoteFor(row: QueueItem, standing: Evidence['strikes']): string {
    const rowId = (row.downloadId ?? row.torrent?.hash)?.toLowerCase();
    const hit = rowId === undefined ? undefined : standing?.find(d => d.downloadId === rowId);
    if (hit === undefined || hit.strikes.length === 0) return '';
    const each = hit.strikes.map(s => `${s.count} strike${s.count === 1 ? '' : 's'}${STRIKE_KIND[s.kind] ?? ''}${s.dryRun === true ? ' (dry run)' : ''}`);
    return ` ${each.join(', ')} from Cleanuparr so far.${hit.markedForRemoval ? ' It has reached Cleanuparr\'s strike limit and is removed on its next run.' : ''}`;
}

/**
 * The import to offer for a grab whose download has finished. Built from a row
 * that carries a download id and not from the row that was picked: a torrent
 * client's row has none.
 */
function importSource(mine: readonly QueueItem[]): QueueItem | undefined {
    // None while the *arr says it is importing the grab itself, as get_queue offers none then,
    // unless it gave reasons: then it keeps failing, and get_queue offers one too.
    const pending = mine.filter(q => {
        if (classifyQueueStatus(q) !== 'importPending' || q.downloadId === undefined) return false;
        const grab = sameGrab(q, mine);
        return !IMPORTING.has(importStateOf(grab) ?? '') || grab.some(g => !isClientRow(g) && importFailing(g));
    });
    return pending.find(q => q.mediaId !== undefined) ?? pending[0];
}

function importStep(mine: readonly QueueItem[], item: MergedItem): NextStep | undefined {
    const source = importSource(mine);
    if (source === undefined) return undefined;
    // Matched to nothing in the library, so an import without a mapping finds nowhere to put it.
    if (needsMapping(source)) return orphanImportStepFor(source);
    return importStateOf(sameGrab(source, mine)) === 'importPending'
        ? retriedImportStepFor(source, item.acquisition?.service)
        : importStepFor(source, item.acquisition?.service);
}

/** Added to an import remedy when the import offered needs a `mapping`. */
function mappingNote(mine: readonly QueueItem[]): string {
    const source = importSource(mine);
    return source !== undefined && needsMapping(source)
        ? ` ${source.service} matched the download to nothing in its library, so the import needs \`mapping\` saying what each file is.`
        : '';
}

/** The rows that stand for this row's download, itself included. */
function sameGrab(row: QueueItem, mine: readonly QueueItem[]): QueueItem[] {
    const key = downloadKey(row);
    return key === undefined ? [row] : mine.filter(q => q === row || downloadKey(q) === key);
}

type Kept = 'importPending' | 'complete' | 'usenet' | 'unconfirmed';

/**
 * Why removing this row would throw away finished files, if it would: its
 * import is pending on another row of the grab, or, short of a failure, every
 * byte of the grab is in the client. The *arrs import none of the second while
 * the warning stands (`TransmissionBase` reads an error string first; a full
 * disk while unpacking is a warning, `Sabnzbd`), and removing it deletes the
 * only copy of the files. A torrent qBittorrent says is missing its files is
 * no such copy.
 *
 * With no client row in the grab, only the *arr's row says nothing is left. On
 * usenet that is a warning from the client's history (`usenet`, read by
 * `usenetRerun`), and the removal stays back, since only the *arr's message
 * tells a download that holds every byte from one the client deleted. A torrent
 * is `unconfirmed`: the *arrs read qBittorrent's missing files as a warning
 * with nothing left, like a finished torrent its client reports an error on
 * (`QBittorrent`, `TransmissionBase`), and only the message tells the two
 * apart, which Radarr and Sonarr word in their UI language. The removal stays
 * back, since it may be the only copy.
 */
function finishedFiles(row: QueueItem, grab: readonly QueueItem[], cls: QueueClass): Kept | undefined {
    if (grab.some(q => q !== row && classifyQueueStatus(q) === 'importPending')) return 'importPending';
    if (cls === 'failed' || grab.some(q => q.status.toLowerCase() === 'missing files')) return undefined;
    if (!grab.some(complete)) return undefined;
    if (grab.some(isClientRow)) return 'complete';
    return row.protocol === 'usenet' ? 'usenet' : 'unconfirmed';
}

/**
 * The remedy for a state in trouble: what else to try beside the removal, or,
 * while finished files keep the removal back, what to do instead. A failure
 * keeps its own remedy whatever else the grab holds, and a state this module
 * does not know is only checked, not explained.
 */
function troubleRemedy(cls: Trouble, kept: Kept | undefined, row: QueueItem, grab: readonly QueueItem[], item: MergedItem): string {
    if (cls === 'failed') return queueFaultRemedy(item);
    if (kept === 'importPending') return queueImportRemedy(item) + mappingNote(grab);
    if (cls === 'unrecognised') return kept === undefined ? queueUnrecognisedRemedy(item) : QUEUE_UNRECOGNISED_KEPT_REMEDY;
    if (kept === undefined) {
        const said = grab.find(isClientRow) ?? row;
        // The managing instance's row, when another instance lists the grab too.
        const arrRows = isClientRow(row) ? grab.filter(q => !isClientRow(q)) : [];
        const arrRow = arrRows.find(q => q.service === item.acquisition?.service) ?? arrRows[0];
        return arrRow === undefined ? queueWarningRemedy(item, said) : queueClientWarningRemedy(item, said, arrRow);
    }
    if (kept === 'usenet') return queueUsenetFinishedRemedy(item, row);
    return kept === 'complete' ? queueFinishedRemedy(item) : queueUnconfirmedRemedy(item, row);
}

function queueStep(ev: Evidence, item: MergedItem): QueueResult {
    if (!ev.queueConfigured) return { step: SKIPPED('queue', 'No download client is configured.') };
    if (ev.queue === undefined) return { step: { stage: 'queue', status: 'unknown', detail: 'No download client could be reached.' } };

    const { items, partial } = ev.queue;
    // A service in `degraded` is unreachable even if the per-stage `partial`
    // list did not say so. Deliberately `degraded` (probe reachability), not
    // `libraryDegraded`: the two once shared one array, so a Radarr
    // library-read failure alone made this stage report unknown even when
    // every download client had answered in full.
    const services = queueServicesFor(item);
    // Services only: a source-scoped id such as `lidarr/one:albums` or
    // `radarr/hd:history` is a read that failed beside the queue, not the queue.
    const effectivePartial = [
        ...new Set([...partial, ...servicesOnly(ev.degraded).filter(s => services.some(t => s === t || s.startsWith(`${t}/`)))])
    ];
    const mine = queueRowsFor(items, item);
    // A file on disk means whatever Cleanuparr removed was replaced since.
    const removals = item.acquisition?.hasFile === true ? [] : (ev.cleanuparr ?? []).filter(e => e.event === 'deleted' || e.event === 'stopped');
    const acted = removals.find(e => e.dryRun !== true) ?? removals[0];

    if (mine.length === 0) {
        // A row for this item could be sitting on the client that failed
        // to answer; a partial read cannot rule that out, so this is
        // "could not fully look", not "looked and found nothing". That holds
        // for a Cleanuparr removal too: a re-grab could be on that client.
        const unreachable = `${effectivePartial.join(', ')} could not be reached, so the queue is only partially known.`;
        if (acted !== undefined) {
            const verb = acted.event === 'deleted' ? 'removed' : 'stopped';
            const strikes = acted.strikeCount === undefined ? '' : `, ${acted.strikeCount} strikes`;
            const why = acted.reason === undefined ? '' : `: ${acted.reason}`;
            const said =
                acted.dryRun === true
                    ? `Cleanuparr would have ${verb} it on ${acted.at.slice(0, 10)}${why} (dry run, nothing was done).`
                    : `Cleanuparr ${verb} it on ${acted.at.slice(0, 10)}${why}${strikes}.`;
            if (effectivePartial.length > 0) return { step: { stage: 'queue', status: 'unknown', detail: `${said} ${unreachable}` } };
            if (acted.dryRun === true) return { step: SKIPPED('queue', said) };
            return {
                step: { stage: 'queue', service: 'cleanuparr', status: 'blocked', detail: said },
                remedy: 'Check the queue cleaner and seeding rules in Cleanuparr for the rule that fired, then search for it again.'
            };
        }
        if (effectivePartial.length > 0) return { step: { stage: 'queue', status: 'unknown', detail: unreachable } };
        return { step: SKIPPED('queue', 'Nothing matching it is in any download queue.') };
    }

    const { row, cls } = pickQueueRow(mine);
    const grab = sameGrab(row, mine);
    const strikeNote = strikeNoteFor(row, ev.strikes);
    const status = row.status.toLowerCase();
    const said = row.errorMessage === undefined ? '' : `: ${row.errorMessage}`;
    const reasons = arrReasons(row, grab);

    if (isTrouble(cls)) {
        const state = status === 'missing files' ? 'is missing files' : row.status;
        // A client's message on a state that is not itself a warning is named as the client's.
        const what = cls === 'warning' && !QUEUE_WARNING.has(status) ? `${row.service} reports a problem with the download` : `Download ${state}`;
        const kept = finishedFiles(row, grab, cls);
        const next: NextStep | undefined =
            kept === undefined
                ? {
                      tool: 'remove_queue_item',
                      arguments: { ...instanceArgs(row.service), id: row.id },
                      why: `Removes the ${cls === 'failed' ? 'failed ' : ''}download from ${row.service} and deletes its partial data. It is not blocklisted${
                          cls === 'warning' && !isClientRow(row) ? '; add `blocklist: true` if the release itself is bad' : ''
                      }.`
                  }
                : importStep(grab, item);
        return {
            ...(next === undefined ? {} : { next }),
            step: { stage: 'queue', service: row.service, status: 'blocked', detail: `${what}${said}.${reasons}${strikeNote}` },
            remedy: troubleRemedy(cls, kept, row, grab, item)
        };
    }

    // A torrent whose file is already in the library has nothing left to import.
    if (cls === 'importPending' && item.acquisition?.hasFile === true && onDisk(row)) {
        return {
            step: {
                stage: 'queue',
                service: row.service,
                status: strikeNote === '' ? 'ok' : 'warning',
                detail: `${SEEDING.has(status) ? 'Seeding' : 'Stopped after it finished'}, and the file is already imported.${strikeNote}`
            }
        };
    }

    if (cls === 'importPending') {
        // A client's row is imported by the *arr that manages the item, not by the client.
        const importer = isClientRow(row) ? item.acquisition?.service : row.service;
        const state = importStateOf(grab);
        if (state === 'importPending' && reasons !== '') {
            const next = importStep(mine, item);
            return {
                step: { stage: 'queue', service: row.service, status: 'blocked', detail: `Downloaded, but ${importer ?? arrOf(item)} could not import it.${reasons}${strikeNote}` },
                remedy: queueImportFailingRemedy(item) + mappingNote(mine),
                ...(next === undefined ? {} : { next })
            };
        }
        // The *arr is importing it now: an import by hand would only race it, so
        // it waits, as a download in progress does, unless the *arr gave reasons.
        if (state !== undefined && IMPORTING.has(state)) {
            return {
                step: {
                    stage: 'queue',
                    service: row.service,
                    status: 'blocked',
                    detail: `Downloaded, and ${importer ?? arrOf(item)} is importing it.${reasons}${strikeNote}`
                },
                ...(reasons === '' ? {} : { remedy: queueImportingRemedy(item) })
            };
        }
        const next = importStep(mine, item);
        const by = importer === undefined ? '' : ` by ${importer}`;
        return {
            step: {
                stage: 'queue',
                service: row.service,
                status: 'blocked',
                detail: `${state === 'importBlocked' ? `Downloaded, but ${importer ?? arrOf(item)} will not import it` : `Downloaded, but not yet imported${by}`}.${reasons}${strikeNote}`
            },
            remedy: (state === 'importBlocked' ? queueImportBlockedRemedy(item) : queueImportRemedy(item)) + mappingNote(mine),
            ...(next === undefined ? {} : { next })
        };
    }

    if (cls === 'unavailable') {
        return {
            step: {
                stage: 'queue',
                service: row.service,
                status: 'blocked',
                detail: `${row.service} is holding this release because it could not send it to a download client.`
            },
            remedy: `Check ${row.service}’s download clients: enabled, reachable and with working credentials. It tries the release again at its next RSS sync.`
        };
    }

    if (cls === 'paused') {
        const { remedy, next } = pausedResume(grab);
        return {
            ...(next === undefined ? {} : { next }),
            step: {
                stage: 'queue',
                service: row.service,
                status: 'blocked',
                detail: `Download ${row.status}${(row.remainingBytes ?? 0) > 0 ? ' before it finished' : ''}${said}.${reasons}${strikeNote}`
            },
            remedy
        };
    }

    // Waiting, like a download in progress: nothing to fix, so no remedy.
    if (cls === 'held') {
        return {
            step: { stage: 'queue', service: row.service, status: 'blocked', detail: `${row.service} is holding this release back and has sent nothing to a download client.` }
        };
    }

    if (cls === 'indeterminate') {
        // The row exists and mentions the item, but neither this module nor
        // the adapter that read it knows what its status means (reported
        // as could-not-classify), not folded into "active", which would claim
        // progress there is no basis for, nor "fault", which would name a
        // problem it cannot.
        return {
            step: {
                stage: 'queue',
                service: row.service,
                status: 'unknown',
                detail: `${row.service} reports a status ("${row.status}") this module does not recognise${said}.`
            }
        };
    }

    const eta = row.etaSeconds === undefined ? '' : `, about ${Math.round(row.etaSeconds / 60)} minute(s) left`;
    // A download genuinely in progress is not a fault: there is nothing to
    // fix, so no remedy; see QueueResult's optional `remedy`.
    return {
        step: {
            stage: 'queue',
            service: row.service,
            status: 'blocked',
            detail: `Still downloading${said}${eta}.${reasons}${strikeNote}`
        }
    };
}

function indexerStep(ev: Evidence, item: MergedItem): Step {
    if (!ev.prowlarrConfigured) return SKIPPED('indexers', 'No indexer manager is configured.');

    const down = ev.prowlarrDegraded;

    // Every instance failed. `rejections` being defined from a stale read must
    // not outvote the probes.
    if (ev.rejections === undefined) {
        return {
            stage: 'indexers',
            status: 'unknown',
            ...(down[0] === undefined ? {} : { service: down[0] }),
            detail: `${down.length > 0 ? down.join(', ') : 'Prowlarr'} could not be reached.`
        };
    }

    const mine = ev.rejections.filter(r => (r.query === undefined ? false : mentions(r.query, item)));
    if (mine.length > 0) {
        const first = mine[0] as IndexerRejection;
        const latest = `most recently ${first.indexer} on ${first.service}: ${first.reason}.`;
        if (ev.indexers === undefined) {
            return { stage: 'indexers', service: first.service, status: 'blocked', detail: `${mine.length} recent indexer failure(s), ${latest}` };
        }
        // Blocks only when the failing or disabled indexers are most of those
        // enabled: the rest still answer a search, so a few failures are a
        // warning. Counted by id, and only the ones still enabled.
        const enabled = new Set(ev.indexers.enabled);
        const failing = new Set(mine.map(rejectionKey).filter(k => enabled.has(k)));
        const disabled = ev.indexers.disabled.filter(k => !failing.has(k)).length;
        return {
            stage: 'indexers',
            service: first.service,
            status: (failing.size + disabled) * 2 > enabled.size ? 'blocked' : 'warning',
            detail: `${mine.length} recent failure(s) from ${failing.size} of ${enabled.size} enabled indexer(s)${disabled > 0 ? `, ${disabled} more disabled by Prowlarr` : ''}, ${latest}`
        };
    }

    // Nothing matched, but part of the answer is missing; the rejection that
    // explains this grab may be in the half that did not answer.
    if (down.length > 0) {
        return {
            stage: 'indexers',
            service: down[0] as string,
            status: 'unknown',
            detail: `${down.join(', ')} could not be reached, so the indexers cannot be ruled out. The rest reported no failures mentioning it.`
        };
    }

    return SKIPPED('indexers', 'No recent indexer failures mention it.');
}

function libraryStep(ev: Evidence, item: MergedItem): Step {
    const server = ev.mediaServer;
    if (server === undefined) return SKIPPED('library', 'No media server is configured.');
    // An artist's presence comes from the music read alone, so the film read
    // failing says nothing about it and the music read failing does, whatever
    // `presence` the join landed on. Unless the server has it, which is a fact.
    const isArtist = item.kind === 'artist';
    const onServer = item.presence === 'both' || item.presence === 'jellyfin_only';
    if (isArtist && !onServer && ev.libraryDegraded.includes(`${server}:music`)) {
        return { stage: 'library', service: server, status: 'unknown', detail: `${server}’s music library could not be read, so whether it has this artist was not checked.` };
    }
    if (!isArtist && ev.libraryDegraded.includes(server)) {
        // Never "it is not in the library" when the library was not asked. Reads
        // `libraryDegraded`, not `degraded`: a failed scan probe belongs to the
        // latter and must not land here, because this stage is about the
        // library *read*. `presence` alone is not enough of a guard either;
        // `unknown` looks like "no evidence at all" to the check below, while
        // `hasFile` is real *arr data this module must not reinterpret.
        return { stage: 'library', service: server, status: 'unknown', detail: `${server} could not be reached, so its library was not checked.` };
    }
    // `unknown` is "never looked", so the file-on-disk branch below would claim
    // the server cannot see an artist it was never asked about.
    if (isArtist && item.presence === 'unknown') {
        return SKIPPED('library', `${server} did not report on music, so whether it has this artist is not known.`);
    }
    const others = Object.entries(item.media_servers ?? {})
        .filter(([id]) => id !== server)
        .map(([id, p]) => (p?.present === true ? ` Also in the ${id} library.` : ` Not in the ${id} library.`))
        .join('');
    if (item.presence === 'both' || item.presence === 'jellyfin_only') {
        return { stage: 'library', service: server, status: 'ok', detail: `Present in the ${server} library.${others}` };
    }
    if (item.acquisition?.hasFile === true) {
        return {
            stage: 'library',
            service: server,
            status: 'blocked',
            detail: `${item.acquisition.service} has a file on disk that ${server} cannot see.${others}`
        };
    }
    return SKIPPED('library', `Not in ${server}, and there is no file for it to have found.${others}`);
}

function scanStep(ev: Evidence): Step {
    const server = ev.mediaServer;
    if (server === undefined) return SKIPPED('scan', 'No media server is configured.');
    if (!ev.scanCapable) return SKIPPED('scan', `${server} cannot report library scan state.`);
    if (ev.degraded.includes(server)) {
        // Specifically the `getScanState` probe, and deliberately not
        // `libraryDegraded`. The two once shared an array, so a failed scan
        // probe silently erased a library read that had succeeded; they are
        // independent endpoints and may disagree about what the server answered.
        return { stage: 'scan', service: server, status: 'unknown', detail: `${server} could not be reached, so its scan state was not checked.` };
    }
    if (ev.scan === undefined) return { stage: 'scan', service: server, status: 'unknown', detail: `${server}’s scan state could not be read.` };
    if (ev.scan.running === true) return { stage: 'scan', service: server, status: 'blocked', detail: 'A library scan is running now. Check again once it finishes.' };
    if (ev.scan.lastCompleted === undefined) return { stage: 'scan', service: server, status: 'unknown', detail: `${server} reports no completed library scan.` };
    return { stage: 'scan', service: server, status: 'ok', detail: `Last library scan completed ${ev.scan.lastCompleted}.` };
}

const LANGUAGE_CODE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;

/**
 * Whether Bazarr is missing subtitles for this item, and the call that would
 * fetch them. Never `blocked`: a film plays without subtitles, so this notes a
 * gap and leaves the verdict where the other stages put it.
 */
function subtitleStep(ev: Evidence, item: MergedItem): { step: Step; sentence: string; next: NextStep[] } {
    const none = (step: Step) => ({ step, sentence: '', next: [] as NextStep[] });
    // Before anything is read: Bazarr has no music, and a gap that shares an
    // artist's name is a film's.
    if (item.kind === 'artist') return none(SKIPPED('subtitles', 'Bazarr has no music, so there are no subtitles to check.'));
    const acquisition = item.acquisition;
    if (acquisition?.hasFile !== true) return none(SKIPPED('subtitles', 'No file on disk, so there is nothing to subtitle yet.'));
    const read = ev.subtitles;
    if (read === null) return none(SKIPPED('subtitles', 'No subtitle service is configured.'));
    if (read === undefined) {
        return none({ stage: 'subtitles', status: 'unknown', detail: 'The subtitle service could not be read, so missing subtitles were not checked.' });
    }

    const service = read.service;
    // Without an id no gap can be matched, which is not the same as none being missing.
    if (acquisition.id === undefined) {
        return none({ stage: 'subtitles', service, status: 'unknown', detail: `${service} was read, but its gaps could not be matched to this item, so missing subtitles were not checked.` });
    }
    // Bazarr pairs with one *arr, and nothing says which, so an id can collide
    // with another instance's: the title has to agree too. A series' gaps are
    // its episodes, matched by series id.
    const mine = read.gaps.filter(
        g =>
            (item.kind === 'series'
                ? g.kind === 'episode' && String(g.seriesId) === acquisition.id
                : g.kind === 'movie' && String(g.id) === acquisition.id) && mentions(g.title, item)
    );
    if (mine.length === 0) return none({ stage: 'subtitles', service, status: 'ok', detail: `${service} lists no missing subtitles for it.` });

    // The language names are Bazarr's own words, so they are fenced here; the gap's title was fenced by its adapter.
    const wanted = (m: SubtitleGap['missing'][number]): string =>
        `${fenceText(m.name, { service, field: 'language' })}${m.forced ? ' (forced)' : ''}${m.hearingImpaired ? ' (hearing impaired)' : ''}`;
    const languages = [...new Set(mine.flatMap(g => g.missing.map(wanted)))];
    const first = mine[0] as SubtitleGap;
    const target = first.missing[0];
    const single = mine.length === 1;
    const where = !single ? `${mine.length} episodes` : first.kind === 'episode' ? `episode ${first.season ?? '?'}x${first.episode ?? '?'}` : 'it';
    // One call covers one item, so several episodes are for get_subtitles to
    // list. The code is Bazarr's raw text and reaches the `Next:` line unfenced,
    // so only a language-code shape passes; that also drops the '??' the adapter
    // reports for a language it gave no code for.
    const next: NextStep[] =
        single && target !== undefined && LANGUAGE_CODE.test(target.code2)
            ? [
                  {
                      tool: 'trigger_subtitle_search',
                      arguments: {
                          ...instanceArgs(first.service),
                          kind: first.kind,
                          id: String(first.id),
                          language: target.code2,
                          ...(target.forced ? { forced: true } : {}),
                          ...(target.hearingImpaired ? { hearing_impaired: true } : {})
                      },
                      why: `Asks ${service} to search for the first of the missing subtitles. It queues the search and returns; finding one is not guaranteed.`
                  }
              ]
            : [];
    const pointer = next.length > 0 ? '' : ' get_subtitles lists what to search for.';
    const sentence = `${service} is missing subtitles for ${where}: ${languages.join(', ')}.${pointer}`;
    return { step: { stage: 'subtitles', service, status: 'warning', detail: sentence }, sentence, next };
}

const REMEDIES: Partial<Record<Stage, string>> = {
    resolve: 'Try search_media, which also looks at what you do not have yet, or request it through Seerr.',
    request: 'Approve or re-submit the request in Seerr.',
    indexers: 'Check the indexer in Prowlarr; get_indexers shows its recent failures.'
    // `queue` is evidence-dependent (see queueStep's QueueResult), `file` is
    // step-status-dependent (see fileRemedy), `managed` names the *arrs the
    // stack runs (see managedRemedy), and `library`/`scan` name the configured
    // server (see libraryRemedy); none of the four fit a static per-stage map.
};

/** One indexer across every Prowlarr: the instance and Prowlarr's own id. */
export const indexerKey = (service: string, id: number | string): string => `${service}\n${id}`;
const rejectionKey = (r: IndexerRejection): string => indexerKey(r.service, r.indexerId ?? `name:${r.indexer}`);

/** The ids that make an item a film or a series: no music item carries them (`jellyfin.ts`, `plex.ts`). */
const FILM_OR_SERIES_IDS = ['tmdb', 'tvdb', 'imdb'] as const;

/**
 * Whether an *arr of this type could manage the item: one of its kind, or,
 * with the kind only guessed (`itemKindGuessed`), any *arr, Lidarr aside when
 * the item carries a film or series id.
 */
const couldManage = (ev: Evidence, item: MergedItem, type: string): boolean => {
    const holds = ARR_KIND[type];
    if (holds === undefined) return false;
    if (ev.itemKindGuessed !== true) return holds === item.kind;
    return holds !== 'artist' || !FILM_OR_SERIES_IDS.some(key => item.ids[key] !== undefined);
};

/**
 * The `managed` remedy. One the unread *arrs left unchecked asks to check
 * them, and one a cleanup rule removed on purpose to protect it first.
 * Otherwise it names only the *arrs this stack runs: for an item one of them
 * has but does not monitor, that one (`monitorStep` carries the call), and for
 * an item nothing manages, the configured *arrs that could manage it
 * (`couldManage`).
 */
function managedRemedy(ev: Evidence, item: MergedItem, step: Step, unreadArrs: readonly string[], removedOnPurpose: boolean): string {
    if (step.status === 'unknown') {
        return unreadArrs.length === 1
            ? `Check that ${unreadArrs[0]} is reachable, then diagnose_media again: it may be managing it.`
            : `Check that ${andList(unreadArrs)} are reachable, then diagnose_media again: one of them may be managing it.`;
    }
    if (removedOnPurpose) {
        return `A cleanup rule removed it on purpose. Protect it in ${ev.cleanup?.service ?? 'the cleanup service'} first, or the same rule will remove it again, then turn monitoring on in ${item.acquisition?.service ?? 'the service managing it'}.`;
    }
    if (item.acquisition !== undefined) return `Turn monitoring on for it in ${arrOf(item)}.`;
    const able = Object.entries(ARR_NAMES).filter(([type]) => couldManage(ev, item, type));
    const here = able.filter(([type]) => ev.arrs.some(id => instanceArgs(id).service === type)).map(([, name]) => name);
    return here.length > 0 ? `Add it to ${orList(here)}.` : `No ${orList(able.map(([, name]) => name))} is configured here to manage it.`;
}

/** `library`/`scan` remedies name the configured media server, so unlike the
 *  rest of `REMEDIES` they can't be static strings. Only called once a
 *  blocking `library`/`scan` step has proven `ev.mediaServer` is set. */
function libraryRemedy(stage: 'library' | 'scan', server: string): string {
    return stage === 'library'
        ? `Trigger a ${server} library scan. If it still does not appear, check the path is inside a ${server} library and readable by it.`
        : `Wait for the running scan, or start one from ${server}’s dashboard.`;
}

/**
 * The remedy must not claim a service was checked when it was not. It once
 * asserted "no indexer reported a failure" unconditionally, printed directly
 * beneath the summary's own "Could not check: queue, prowlarr".
 *
 * `'skipped'` alone cannot tell "not configured" from "checked and found
 * nothing", since both steps return it for either. So the *configured* flags
 * decide "not configured" and `'unknown'` decides "unreachable"; a service
 * gets credit for being checked only when neither applies.
 */
function fileRemedy(service: string, ev: Evidence, queueStatus: StepStatus, indexerStatus: StepStatus): string {
    const uncheckable: string[] = [];
    if (!ev.queueConfigured) uncheckable.push('no download client is configured');
    else if (queueStatus === 'unknown') uncheckable.push('the download client(s) could not be fully checked');
    if (!ev.prowlarrConfigured) uncheckable.push('no indexer manager is configured');
    else if (indexerStatus === 'unknown') uncheckable.push('Prowlarr could not be reached');

    const search = `Trigger a search in ${service}`;
    if (uncheckable.length === 0) {
        return indexerStatus === 'warning'
            ? `${search}. Nothing is downloading, and most indexers reported no failure.`
            : `${search}. Nothing is downloading and no indexer reported a failure.`;
    }
    return `${search} (${uncheckable.join(' and ')}, so that could not be ruled out).`;
}

/**
 * Why a search for an artist with no tracks would grab nothing, when its albums
 * were read and say so. A Lidarr search asks only for the monitored albums
 * (`ReleaseSearchService.ArtistSearch`) and rejects every release outside them
 * (`AlbumRequestedSpecification`). A list cut off at 500 says nothing about the
 * albums it left out, so it decides nothing.
 */
function unsearchable(ev: Evidence): 'no albums' | 'none monitored' | undefined {
    if (ev.item?.kind !== 'artist' || ev.albums === undefined || ev.albums.truncated) return undefined;
    if (ev.albums.list.length === 0) return 'no albums';
    return ev.albums.list.some(a => a.monitored) ? undefined : 'none monitored';
}

function unsearchableRemedy(ev: Evidence, service: string): string | undefined {
    const why = unsearchable(ev);
    if (why === 'no albums') {
        return `${service} lists no albums for it, so a search has nothing to grab. Refresh the artist with trigger_scan so ${service} fetches them, or check its metadata profile, which decides which albums ${service} adds.`;
    }
    if (why === 'none monitored') {
        const count = ev.albums?.list.length ?? 0;
        const which = count === 1 ? 'Its one album is not monitored' : `None of its ${count} albums is monitored`;
        return `${which} in ${service}, and a search grabs only releases of a monitored album, so it would grab nothing. Monitor the albums you want with set_monitoring at \`level: "album"\`, then search.`;
    }
    return undefined;
}

/**
 * A queue row can be genuinely blocked while `file` is still `ok`; a failing
 * upgrade grab, say. That must not outrank a green chain, but going silent
 * about a real failure over-corrects: it is worth a mention, not the verdict.
 *
 * The wording changes on `fileIsOk`, rather than being suppressed by it
 * (a review finding's second symptom). A `request`/`managed`
 * verdict with genuinely no file yet (`monitored: false` *and*
 * `hasFile: false`) and a faulted queue row used to go silent about that
 * fault entirely: "…is not monitored." with a "turn monitoring on" remedy
 * that is not just incomplete but actively wrong, while the real cause
 * (`queueResult.step.detail`, e.g. "Download failed: news server refused")
 * sat discarded. `fileIsOk` still decides *which sentence*: true asserts a
 * file already exists ("does not block the file already on disk"), which
 * would be a fabricated claim when there is no file; false instead flags
 * the fault as the plausible actual cause of the verdict above it.
 */
const queueAside = (queueResult: QueueResult, fileIsOk: boolean, kind: MergedItem['kind']): string => {
    if (queueResult.step.status !== 'blocked') return '';
    if (queueResult.remedy === undefined) {
        // Nothing to fix, but a series' or an artist's file is any episode or
        // track, so a grab still on its way may be the very one asked about.
        return fileIsOk && kind !== 'movie'
            ? ` (Also: ${queueResult.step.detail} This may be ${kind === 'artist' ? 'an album' : 'an episode'} you do not have yet.)`
            : '';
    }
    return fileIsOk
        ? ` (Also: ${queueResult.step.detail} This does not block the file already on disk, but may be worth checking.)`
        : ` (Also: ${queueResult.step.detail} There is no file on disk yet, so this may be the actual cause. Worth checking before assuming the remedy above will fix it.)`;
};

/**
 * A disclosure, not a fix. Evidence genuinely cannot tell "an ended series
 * deliberately left unmonitored" from "an ongoing one accidentally
 * unmonitored", so this says so rather than guessing.
 *
 * Only for `request`/`managed` verdicts on a series or an artist with a file
 * already visible in the configured media server; a movie in that position is
 * excluded upstream, so "episodes (or albums) you do not have yet" is always
 * literally true here.
 */
const seriesFileVisibleHedge = (server: string, item: MergedItem): string =>
    ` (A file is already on disk and visible in ${server}. This may only affect ${item.kind === 'artist' ? 'albums' : 'episodes'} you do not have yet.)`;

/**
 * The top-level `Diagnosis.degraded` a caller sees, and the input to the
 * `resolve` verdict's own certainty below, are both "everything this
 * diagnosis could not fully check"; the union of probe reachability and
 * library-read reachability. The two are kept separate for the per-stage
 * checks above, which each care about only one; nothing downstream of here
 * needs the distinction.
 */
const allDegraded = (ev: Evidence): string[] => [...new Set([...ev.degraded, ...ev.libraryDegraded])].sort();

/**
 * The same union, minus source-scoped ids (`gather.ts`'s `servicesOnly`); the
 * input to the `resolve` verdict's certainty, which is a claim about whether a
 * *service* could be asked.
 *
 * No stage of this chain reads `seasons`, so a failed `jellyfin:seasons` read
 * says nothing about whether a title exists or where it is stuck. Counted, it
 * made every diagnose verdict on a stack with a broken episode endpoint report
 * `certain: false`, hedging eight stages against a hole in none of them. The
 * top-level `degraded` still lists it: naming what did not answer is honest,
 * doubting an unrelated verdict over it is not.
 */
const certaintyDegraded = (ev: Evidence): string[] => servicesOnly(allDegraded(ev));

/**
 * The *arrs that could manage the item (`couldManage`), any instance, whose
 * library read failed. Any of them may hold an item no other source claims; a
 * source-scoped id such as `jellyfin:music` is a media server's read, never an
 * *arr's.
 */
const arrsUnreadFor = (ev: Evidence, item: MergedItem): string[] =>
    servicesOnly(ev.libraryDegraded).filter(id => couldManage(ev, item, id.split('/')[0] ?? ''));

/** `a`, `a and b`, `a, b and c`, or the same with `or`. */
const listWith =
    (word: string) =>
    (names: readonly string[]): string =>
        names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} ${word} ${names.at(-1) as string}`;
const andList = listWith('and');
const orList = listWith('or');

const withSteps = (next: NextStep[]): { next_steps?: NextStep[] } => (next.length === 0 ? {} : { next_steps: next });

/**
 * Only the caller's own words go into a lookup: when the target was an id, the
 * only text to hand over is a service's title, which stays out of arguments.
 */
const lookupStep = (query: string, byWords: boolean): NextStep[] =>
    byWords ? [{ tool: 'search_media', arguments: { query, source: 'discover' }, why: 'Checks whether it exists anywhere before adding it.' }] : [];

/** The monitoring call for an item a service has but is not monitoring. Radarr has no `setMonitoring`, so it goes through `update_media`. */
function monitorStep(acquisition: NonNullable<MergedItem['acquisition']>, item: MergedItem): NextStep[] {
    if (acquisition.id === undefined) return [];
    const target = instanceArgs(acquisition.service);
    if (item.kind === 'artist') {
        return [
            {
                tool: 'update_media',
                arguments: { ...target, id: acquisition.id, monitored: true },
                why: `Turns on the artist-level monitor flag in ${acquisition.service}. Each album keeps its own monitor flag, which this does not change.`
            }
        ];
    }
    return [
        {
            tool: target.service === 'radarr' ? 'update_media' : 'set_monitoring',
            arguments: { ...target, id: acquisition.id, monitored: true },
            why: `Turns monitoring on in ${acquisition.service}, so it looks for what is missing.`
        }
    ];
}

export function buildChain(query: string, ev: Evidence, byWords: boolean): Diagnosis {
    const steps: Step[] = [];

    if (ev.item === undefined) {
        const releases = releasesOf(ev.history ?? []).map(releaseSentence);
        const shown = releases.slice(0, HISTORY_RELEASES_SHOWN);
        const more = releases.length - shown.length;
        steps.push({
            stage: 'resolve',
            status: 'blocked',
            detail:
                releases.length === 0
                    ? 'No configured service knows this title.'
                    : 'No configured service knows this title, but download history has a release by that name.'
        });
        for (const stage of DISPLAY_ORDER.slice(1)) steps.push(SKIPPED(stage, 'Not reached. The item was never identified.'));

        const summary =
            releases.length === 0
                ? `Nothing in your stack matches "${query}".`
                : `Nothing in your library matches "${query}", but download history does. ${shown.map(r => r.said).join(' ')}${
                      more > 0 ? ` ${more} more matching release(s) in \`history\`.` : ''
                  }`;
        return {
            query,
            steps,
            verdict: {
                stage: 'resolve',
                summary,
                remedy:
                    releases.length === 0
                        ? (REMEDIES.resolve as string)
                        : `Nothing manages it now, so nothing will grab it again. If you still want it, find it with search_media \`source: "discover"\` and add it with add_media; get_history${
                              // Only a stored event has these, and the default source would not show it.
                              (ev.history ?? []).some(r => r.externalIds !== undefined) ? ' with source: "webhooks"' : ''
                          } shows the full trail.`,
                // Not knowing about it and not being able to look are different
                // answers, and a degraded library service means the second
                // (whether the library read itself failed or a diagnose probe did).
                ...withSteps(lookupStep(query, byWords)),
                certain: certaintyDegraded(ev).length === 0
            },
            ...(releases.length === 0 ? {} : { history: releases.map(r => r.row) }),
            degraded: allDegraded(ev)
        };
    }

    const item = ev.item;
    const acquisition = item.acquisition;

    steps.push({ stage: 'resolve', status: 'ok', detail: `Identified as ${item.title}.` });
    steps.push(requestStep(ev, item));

    // `file` is now computed whenever Radarr/Sonarr knows about the item at
    // all, regardless of `monitored`; a file can exist on disk even when
    // monitoring is off, and the check below needs that real signal to
    // tell "not monitored, and also no file" apart from "not monitored, but
    // it is sitting right there".
    const unreadArrs = acquisition === undefined ? arrsUnreadFor(ev, item) : [];
    if (unreadArrs.length > 0) {
        // An *arr of this kind (any, when the kind was only guessed) whose
        // library read failed may hold the item, so "nothing manages it" is
        // unproven, and a lookup would ask it too.
        steps.push({
            stage: 'managed',
            service: unreadArrs.join(', '),
            status: 'unknown',
            detail: `${andList(unreadArrs)} could not be read, so whether anything manages it was not checked.`
        });
        steps.push(SKIPPED('file', 'Not reached. Whether anything manages it is not known.'));
    } else if (acquisition === undefined) {
        // Not a list of the two *arrs, because the stack may run a third:
        // this is the branch where nothing configured claims the item, and
        // naming services that were never asked reads as a claim they were.
        steps.push({ stage: 'managed', status: 'blocked', detail: 'Nothing configured here is managing it.' });
        steps.push(SKIPPED('file', 'Not reached. Nothing is managing it.'));
    } else {
        steps.push(
            acquisition.monitored
                ? { stage: 'managed', service: acquisition.service, status: 'ok', detail: `Monitored in ${acquisition.service}.` }
                : {
                      stage: 'managed',
                      service: acquisition.service,
                      status: 'blocked',
                      detail: `${acquisition.service} has it, but it is not monitored.`
                  }
        );
        const removed = acquisition.hasFile ? undefined : wholeRemoval(ev.cleanup, ev.lastImportAt);
        // Searching again for something a cleanup rule removed only gets it removed again.
        const unread =
            ev.cleanupUnread === undefined
                ? ''
                : ` ${ev.cleanupUnread} could not be read, so whether a cleanup rule removed it is unknown: check there before searching again.`;
        steps.push(
            acquisition.hasFile
                ? { stage: 'file', service: acquisition.service, status: 'ok', detail: 'A file is on disk.' }
                : removed !== undefined
                  ? { stage: 'file', service: acquisition.service, status: 'blocked', detail: `No file on disk: ${removalSentence(ev.cleanup?.service ?? 'the cleanup service', removed)}` }
                  : { stage: 'file', service: acquisition.service, status: 'blocked', detail: `No file on disk yet.${unread}` }
        );
    }

    const queueResult = queueStep(ev, item);
    steps.push(queueResult.step);
    steps.push(indexerStep(ev, item));
    steps.push(libraryStep(ev, item));
    steps.push(scanStep(ev));
    const subtitles = subtitleStep(ev, item);
    steps.push(subtitles.step);

    const byStage = new Map(steps.map(s => [s.stage, s]));
    const isBlocked = (s: Stage): boolean => byStage.get(s)?.status === 'blocked';
    // A file already on disk is proof that whatever request/managed history
    // led here worked well enough to produce it. An old declined or pending
    // request, or `monitored: false`, cannot be why playback fails when the
    // file is sitting right there; from here only the media server's
    // visibility of it matters.
    const fileIsOk = byStage.get('file')?.status === 'ok';
    const libStep = byStage.get('library');
    // In the media server with nothing managing it: that copy plays, and
    // "add it" would only fetch a second one. The verdict says nothing will
    // upgrade or replace it instead.
    const unmanagedOnServer = acquisition === undefined && unreadArrs.length === 0 && libStep?.status === 'ok';
    if (unmanagedOnServer) {
        // The step agrees with the verdict and still says nothing manages it.
        const at = steps.findIndex(s => s.stage === 'managed');
        const managed = { stage: 'managed', status: 'warning', detail: 'Nothing configured here manages it, so nothing will upgrade or replace the copy in the library.' } as const;
        steps[at] = managed;
        byStage.set('managed', managed);
    }
    const hasCopy = fileIsOk || unmanagedOnServer;
    // The guard for `seriesFileVisibleHedge`, below: a file confirmed on
    // disk *and* confirmed visible in the media server, independent of which
    // verdict stage the file/library steps themselves ended up producing.
    const libraryConfirmedOk = hasCopy && libStep?.status === 'ok';
    // `fileIsOk` means something different for a series than for a movie.
    // A movie's `hasFile` is unambiguous: this exact file is or is not on
    // disk. A series' `hasFile` (`sonarr.ts`: `episodeFileCount > 0`) is
    // "any episode has a file", true for a show sitting on seasons 1-4
    // while season 5, the actual question, has never arrived. Excluding
    // request/managed there would silently drop the single most common
    // series diagnosis, "monitoring got turned off" / "the new-season
    // request is still pending", under a confident "is available in
    // <server> and playable", with no remedy and no mention. So the
    // exclusion applies only where the signal it depends on is actually
    // unambiguous: movies.
    const excludeRequestManaged = hasCopy && item.kind === 'movie';
    // A declined, failed or indeterminate request says nothing about an item an *arr
    // monitors anyway (added by hand, or requested again since), or a series
    // the media server already has with nothing managing it: the file, the
    // queue or that copy decide, and the request is only mentioned. A pending
    // one stays the verdict for a series, which may be asking for more of it.
    const staleRequest =
        !excludeRequestManaged &&
        isBlocked('request') &&
        ev.request?.status !== 'pending' &&
        (acquisition?.monitored === true || unmanagedOnServer);
    const requestAside = staleRequest
        ? ` (Also: the Seerr request ${
              ev.request?.status === 'declined' ? 'was declined' : ev.request?.status === 'failed' ? 'failed' : 'is in an indeterminate state'
          }, but ${
              unmanagedOnServer ? `it is in ${ev.mediaServer} anyway` : `${arrOf(item)} monitors it anyway`
          }, so the request does not hold it up.)`
        : '';

    let verdictStage: Stage | undefined;
    let certaintyPath: Stage[];

    if (!excludeRequestManaged && isBlocked('request') && !staleRequest) {
        verdictStage = 'request';
        certaintyPath = ['request'];
    } else if (!excludeRequestManaged && isBlocked('managed') && !unmanagedOnServer) {
        verdictStage = 'managed';
        certaintyPath = ['request', 'managed'];
    } else if (unreadArrs.length > 0) {
        // Nothing claims it and an *arr that may hold it could not be read:
        // that open question stays the verdict, uncertain, rather than falling
        // through to a "playable" summary written for an item an *arr holds.
        verdictStage = 'managed';
        certaintyPath = ['request', 'managed'];
    } else if (isBlocked('file')) {
        // A missing file is a symptom, not the cause: a stalled download or
        // a dead indexer is. It is only reached here because `file` is
        // genuinely `blocked`, not merely mentioned by an unrelated row.
        if (isBlocked('queue')) {
            // Checked first: a queue row is live, current evidence about an
            // attempt happening right now, while an indexer rejection is
            // drawn from a rolling history that can predate the grab
            // actually stuck. When both are present, the live signal wins
            // over the historical one.
            verdictStage = 'queue';
            certaintyPath = ['request', 'managed', 'queue'];
        } else if (isBlocked('indexers')) {
            verdictStage = 'indexers';
            certaintyPath = ['request', 'managed', 'queue', 'indexers'];
        } else {
            verdictStage = 'file';
            certaintyPath = ['request', 'managed', 'queue', 'indexers', 'file'];
        }
    } else if (isBlocked('library')) {
        // Only reachable with `fileIsOk` true; `libraryStep` can only
        // report `blocked` when `acquisition.hasFile === true`, which is
        // exactly `file`'s own `ok` condition. request/managed are excluded
        // above, and correctly so: a scan explains a blocked library, and
        // an unknown scan costs certainty even when library alone would
        // have been enough to verdict on, so both apply here.
        verdictStage = isBlocked('scan') ? 'scan' : 'library';
        certaintyPath = ['file', 'library', 'scan'];
    } else {
        verdictStage = undefined; // playable
        certaintyPath = excludeRequestManaged ? ['file', 'library'] : ['request', 'managed', 'file', 'library'];
    }

    const unchecked = certaintyPath.filter(s => byStage.get(s)?.status === 'unknown');
    const certain = unchecked.length === 0;

    // The verdict's own stage is left out: an unknown `managed` verdict
    // already names what it could not read.
    const uncheckedElsewhere = unchecked.filter(s => s !== verdictStage);
    const caveat =
        uncheckedElsewhere.length === 0
            ? ''
            : ` Could not check: ${[...new Set(uncheckedElsewhere.map(s => byStage.get(s)?.service ?? s))].join(', ')}.`;
    // `fileIsOk` still decides which of the two `queueAside` sentences
    // applies (see its own doc comment); it no longer decides whether one
    // appears at all. A confirmed file is what lets the true wording say
    // "does not block the file already on disk"; its absence gets the
    // "may be the actual cause" wording instead, not silence.
    // The cleanup sentence is left out only where the verdict itself quotes it:
    // the file step's detail is not what a `managed` or `request` verdict says.
    const verdictDetail = verdictStage === undefined ? undefined : byStage.get(verdictStage)?.detail;
    // Indexer failures too few to be the verdict are named beside a missing
    // file, whose search they may still slow down.
    const indexers = byStage.get('indexers');
    const indexerAside = verdictStage === 'file' && indexers?.status === 'warning' ? ` (Also: ${indexers.detail})` : '';
    const aside = queueAside(queueResult, hasCopy, item.kind) + indexerAside + requestAside + cleanupAside(ev, verdictDetail);

    if (verdictStage === undefined) {
        // The positive claim "is available in <server> and playable" is only
        // honest when `library` itself said `ok`; read the step, not just
        // whether a media server is configured: `certain: false` alone does
        // not retract an unqualified sentence sitting right next to it.
        // The third branch is reachable only when `library` was skipped for
        // having no server (see `libraryStep`), `file` being blocked would
        // have taken a different verdict branch otherwise, so it echoes
        // `libraryStep`'s own wording rather than inventing a second one.
        // `hasFile` on an artist is any track at all, which is nowhere near
        // "playable": the albums are one read down and may hold none. An
        // unmanaged artist has no *arr count at all, only the server's copy.
        const unmanaged = unmanagedOnServer ? ' Nothing configured here manages it, so nothing will upgrade or replace it.' : '';
        const summary =
            item.kind === 'artist' && !unmanagedOnServer
                ? `${item.title} has tracks on disk. That only means at least one track is there: get_media_details lists its albums and which of them have files. ${libStep?.detail ?? ''}${caveat}${aside}`
                : libStep?.status === 'ok'
                  ? `${item.title} is available in ${ev.mediaServer} and playable.${unmanaged}${caveat}${aside}`
                  : libStep?.status === 'unknown'
                    ? `${item.title} has a file, but ${ev.mediaServer} could not be reached to confirm it is visible there.${caveat}${aside}`
                    : `${item.title} is on disk. No media server is configured.${caveat}${aside}`;

        return {
            query,
            resolved: resolvedOf(item),
            steps,
            // The one playable verdict with a next step, and not a fix: it
            // stands, and the call only fetches the subtitles it notes.
            verdict: {
                stage: 'playable',
                summary: `${summary}${subtitles.sentence === '' ? '' : ` ${subtitles.sentence}`}`,
                ...withSteps(subtitles.next),
                certain
            },
            degraded: allDegraded(ev)
        };
    }

    const blocking = byStage.get(verdictStage) as Step;
    const removedOnPurpose = acquisition?.hasFile === false && wholeRemoval(ev.cleanup, ev.lastImportAt) !== undefined;
    const remedy =
        blocking.stage === 'queue'
            ? queueResult.remedy
            : blocking.stage === 'managed'
              ? managedRemedy(ev, item, blocking, unreadArrs, removedOnPurpose)
              : blocking.stage === 'file'
              // The `file` step always carries the managing service: it is only
              // pushed on the branch where `acquisition` is defined.
              ? removedOnPurpose
                  ? `A cleanup rule removed it on purpose. Protect it in ${ev.cleanup?.service ?? 'the cleanup service'} first, or the same rule will remove it again, then search for it in ${blocking.service as string}.`
                  : (unsearchableRemedy(ev, blocking.service as string) ??
                    fileRemedy(
                        blocking.service as string,
                        ev,
                        byStage.get('queue')?.status ?? 'unknown',
                        byStage.get('indexers')?.status ?? 'unknown'
                    ))
              : blocking.stage === 'library' || blocking.stage === 'scan'
                ? libraryRemedy(blocking.stage, ev.mediaServer as string)
                : REMEDIES[blocking.stage];
    // The verdict's own stage is never also the aside (it is already the
    // headline), so `aside` only ever adds information here for a
    // non-queue verdict; same guard as the playable branch above. A request
    // the queue outranked still gets its mention.
    const summaryAside = blocking.stage === 'queue' ? requestAside : aside;
    const next = nextStepsFor(blocking.stage, { ev, query, byWords, queueNext: queueResult.next });
    // Item 3's first symptom: a `request`/`managed` verdict outranking a
    // library that is genuinely, confirmedly fine (`libraryConfirmedOk`) used
    // to leave that fact sitting unmentioned in `steps`, nowhere in the
    // summary a caller actually reads. Only `request`/`managed`, `file`,
    // `queue`, `indexers`, `library` and `scan` are all cases where `library`
    // is either not yet meaningful or is already the point.
    const hedge =
        libraryConfirmedOk && (blocking.stage === 'request' || blocking.stage === 'managed')
            ? seriesFileVisibleHedge(ev.mediaServer as string, item)
            : '';

    return {
        query,
        resolved: resolvedOf(item),
        steps,
        verdict: {
            stage: blocking.stage,
            summary: `${blocking.detail}${caveat}${hedge}${summaryAside}`,
            ...(remedy === undefined ? {} : { remedy }),
            ...withSteps(next),
            certain
        },
        degraded: allDegraded(ev)
    };
}

/**
 * The call behind each stage's `remedy`, where one exists. `indexers`, `scan`
 * and a download still in progress have nothing to call, and a file a cleanup
 * rule removed is protected in that service, not searched for again.
 */
function nextStepsFor(
    stage: Stage,
    { ev, query, byWords, queueNext }: { ev: Evidence; query: string; byWords: boolean; queueNext: NextStep | undefined }
): NextStep[] {
    const item = ev.item;
    const acquisition = item?.acquisition;

    switch (stage) {
        case 'request': {
            const status = ev.request?.status;
            if ((status !== 'pending' && status !== 'failed') || ev.request?.id === undefined || ev.request.mayRespond !== true) return [];
            const arr = SEERR_ARR[seerrMediaType(item?.kind)];
            return [
                status === 'pending'
                    ? { tool: 'respond_to_request', arguments: { id: String(ev.request.id), verdict: 'approve' }, why: `Approving hands the request to ${arr} to search for it.` }
                    : { tool: 'respond_to_request', arguments: { id: String(ev.request.id), verdict: 'retry' }, why: `Retrying sends the request to ${arr} again.` }
            ];
        }
        case 'managed':
            // `managed` is unknown with an *arr that could manage it unread,
            // and a lookup would ask it too.
            if (item !== undefined && acquisition === undefined && arrsUnreadFor(ev, item).length > 0) return [];
            // An artist nothing manages gets the same lookup as a film or a
            // series: search_media `source: "discover"` answers with Lidarr's artists, each with the
            // MusicBrainz id add_media takes.
            if (item === undefined || acquisition === undefined) return lookupStep(query, byWords);
            // Monitoring would search for, and so re-download, what a rule deleted on purpose: the file step withholds its search for this reason.
            if (!acquisition.hasFile && wholeRemoval(ev.cleanup, ev.lastImportAt) !== undefined) return [];
            return monitorStep(acquisition, item);
        case 'file': {
            if (acquisition?.id === undefined || (!acquisition.hasFile && wholeRemoval(ev.cleanup, ev.lastImportAt) !== undefined)) return [];
            const target = instanceArgs(acquisition.service);
            const why = unsearchable(ev);
            if (why === 'no albums') {
                return [
                    {
                        tool: 'trigger_scan',
                        arguments: { ...target, action: 'scan', id: acquisition.id },
                        why: `Refreshes the artist from the metadata provider, so ${acquisition.service} lists its albums.`
                    }
                ];
            }
            if (why === 'none monitored') {
                const only = ev.albums?.list.length === 1 ? ev.albums.list[0] : undefined;
                return [
                    only === undefined
                        ? {
                              tool: 'get_media_details',
                              arguments: { ...target, id: acquisition.id, detail: 'full' },
                              why: 'Lists its albums and their ids, to choose which to monitor with set_monitoring at `level: "album"`.'
                          }
                        : {
                              tool: 'set_monitoring',
                              arguments: { ...target, level: 'album', id: only.id, monitored: true },
                              why: 'Monitors its only album, so a search has something to grab.'
                          }
                ];
            }
            return [
                {
                    tool: 'trigger_search',
                    arguments: { ...target, id: acquisition.id },
                    why: `Searches ${acquisition.service} for ${item?.kind === 'artist' ? "the artist's monitored albums" : 'the missing file'}.${
                        ev.cleanupUnread === undefined
                            ? ''
                            : ` ${ev.cleanupUnread} could not be read, so check it for a cleanup rule before searching again.`
                    }`
                }
            ];
        }
        case 'queue':
            return queueNext === undefined ? [] : [queueNext];
        case 'library':
            return ev.mediaServer === undefined
                ? []
                : [
                      {
                          tool: 'trigger_scan',
                          arguments: { ...instanceArgs(ev.mediaServer), action: 'scan' },
                          why: `${ev.mediaServer} has not picked up the file that is on disk.`
                      }
                  ];
        default:
            return [];
    }
}

/**
 * A removal of the title itself and the newest thing to happen to its file.
 * Not a season or an episode, which leave the rest on disk. One movie version
 * counts: this only runs when the *arr has no file, and Radarr keeps one file
 * per movie, so that version was it. Not one followed by an import either: the
 * title came back after it, so whatever took the file since was something else.
 */
export function wholeRemoval(cleanup: CleanupStatus | null | undefined, lastImportAt: string | undefined): CleanupRemoval | undefined {
    const latest = cleanup?.removals.find(r => r.scope === 'movie' || r.scope === 'version' || r.scope === 'series');
    return latest === undefined || (lastImportAt !== undefined && instantOf(lastImportAt) > instantOf(latest.at)) ? undefined : latest;
}

/**
 * What the cleanup service is about to do to this title, or did to part of it.
 * Not a stage: a deletion that has not happened blocks nothing, but someone
 * asking about a title should hear it is about to go.
 */
function cleanupAside(ev: Evidence, fileDetail: string | undefined): string {
    const cleanup = ev.cleanup;
    if (cleanup === null || cleanup === undefined) return '';
    const upcoming = upcomingSentence(cleanup.service, cleanup.candidates);
    if (upcoming !== undefined) return ` (Also: ${upcoming})`;
    const latest = cleanup.removals[0];
    if (latest === undefined) return '';
    // A file on disk after a whole-title removal means it came back since. A
    // version removal stays worth saying: the file on disk may be another version.
    if (ev.item?.acquisition?.hasFile === true && (latest.scope === 'movie' || latest.scope === 'series')) return '';
    const sentence = removalSentence(cleanup.service, latest);
    // Already the file step's own detail, which the verdict quotes.
    if (fileDetail?.includes(sentence) === true) return '';
    return ` (Also: ${sentence})`;
}

const resolvedOf = (item: MergedItem): NonNullable<Diagnosis['resolved']> => ({
    title: item.title,
    ...(item.year === undefined ? {} : { year: item.year }),
    kind: item.kind,
    ids: item.ids
});
