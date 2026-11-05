import type { ServiceId } from '../../config/schema.ts';
import { servicesOnly } from '../../core/gather.ts';
import type { NextStep } from '../../core/nextStep.ts';
import { unfenced } from '../../core/titleMatch.ts';
import { currentStrikes } from '../cleanuparrQueue.ts';
import type { MergedItem } from '../../core/resolver.ts';
import { fenceText } from '../../core/fence.ts';
import type { CleanupRemoval, CleanupStatus, HistoryEntry, IndexerRejection, QueueItem, RequestStatus, ScanState, SubtitleGap } from '../../services/types.ts';
import { removalSentence, upcomingSentence } from '../cleanupStatus.ts';
import { instanceArgs } from '../resolveInstance.ts';

export type Stage = 'resolve' | 'request' | 'managed' | 'file' | 'queue' | 'indexers' | 'library' | 'scan' | 'subtitles';
/** `warning` is worth a look but blocks nothing. */
export type StepStatus = 'ok' | 'warning' | 'blocked' | 'unknown' | 'skipped';

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
     * `id` is Seerr's own request id, the one `respond_to_request` takes.
     * `mayRespond` is whether that tool's own check would let the caller act on
     * it (their request, or `allow_other_users`); absent reads as no, so a
     * request whose owner is unknown gets no approval offered.
     */
    request: { status: RequestStatus | 'unknown'; id?: number; mayRespond?: boolean } | null | undefined;
    /**
     * `items` is what the collector actually read, `partial` names the clients
     * that did not answer. One unreachable client used to erase the whole stage,
     * discarding rows another client did return — including the stalled row that
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
    scan: ScanState | undefined;
    /**
     * A third state beyond looked/could-not-look: **never configured**. Without
     * it, a stack with no media server gets "Jellyfin cannot see it" — a claim
     * about a service the user does not run.
     *
     * The configured media server's id, absent when none is configured —
     * the stages need the name, not just whether one exists.
     */
    mediaServer?: string;
    /** Whether that media server can report scan state at all. */
    scanCapable: boolean;
    /** Cleanuparr events for this item's downloads, newest first. null: not configured. */
    cleanuparr: HistoryEntry[] | null | undefined;
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
     * call every queue unknown. Only `libraryStep` reads this; every other
     * step reads `degraded`.
     */
    libraryDegraded: readonly string[];
    degraded: readonly string[];
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

/** Reported in this order — it is the order the pipeline actually runs in. */
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

    // The needle is unfenced before tokenising, so the haystack must be too —
    // otherwise the fence markers themselves become haystack tokens.
    const hayWords = tokenize(unfenced(haystack));
    const haySet = new Set(hayWords);
    if (!words.every(w => haySet.has(w))) return false;

    // A series release's year is the episode's, not the show's start year:
    // "The.Simpsons.S32E01.2020" is no mismatch for a show that began in 1989.
    // Skip the guard entirely for series.
    if (item.kind !== 'series' && item.year !== undefined) {
        // A year inside the title itself — "2049", "1917", "2001" — is not
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
 * no library item to compare against — the history fallback below. The query
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

/**
 * One sentence per release for the history fallback. Cleanuparr removing or
 * stopping it is the answer when it did; a client's own outcome otherwise.
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
    const row = rows[0] as HistoryEntry;
    if (row.service === 'cleanuparr' && row.event === 'strike') {
        const count = row.strikeCount === undefined ? '' : ` ${row.strikeCount} times`;
        return { row, said: `Cleanuparr struck ${row.title}${count}${STRIKE_KIND[row.rawEvent ?? ''] ?? ''}, last on ${row.at.slice(0, 10)}.` };
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
    // but the item had no tmdb id to match against (evidence.ts) — the
    // wording has to hold in both cases rather than asserting an outage that
    // may not have happened.
    if (ev.request === undefined) {
        return { stage: 'request', service: 'seerr', status: 'unknown', detail: 'Could not determine whether this was requested.' };
    }
    if (ev.request === null) return SKIPPED('request', 'No request recorded — not everything arrives through Seerr.');

    if (ev.request.status === 'declined') {
        return { stage: 'request', service: 'seerr', status: 'blocked', detail: 'The request was declined.' };
    }
    if (ev.request.status === 'pending') {
        return { stage: 'request', service: 'seerr', status: 'blocked', detail: 'The request is still awaiting approval.' };
    }
    if (ev.request.status === 'unknown') {
        // Seerr answered, but not with a status this module recognises as a
        // success — e.g. Overseerr's own FAILED. Reporting that as `ok`
        // ("The request is unknown.") would be green on a request that never
        // went anywhere.
        return {
            stage: 'request',
            service: 'seerr',
            status: 'blocked',
            detail: 'Seerr reports the request in an indeterminate state — it may have failed to submit.'
        };
    }
    return { stage: 'request', service: 'seerr', status: 'ok', detail: `The request is ${ev.request.status}.` };
}

/**
 * An explicit set, not a regex over free text. `/stall|fail|error|paused/i`
 * reads `completed` — a download waiting to be imported, which is exactly the
 * broken import this tool exists to surface — as "still downloading", because
 * "complete" contains none of those substrings. It misreads
 * `downloadClientUnavailable` and `warning`/`delay` the same way.
 *
 * The vocabulary is what the adapters actually emit, lowercased. `seeding`,
 * qBittorrent's `seeding (no peers)` and `queued to seed` mean the file is fully on disk, so they are import-pending
 * rather than active; `propagating` is SABnzbd finalising a healthy download,
 * so it stays active.
 */
const QUEUE_ACTIVE = new Set([
    'downloading',
    'queued',
    'queued to verify',
    'verifying',
    'fetching',
    'checking',
    'extracting',
    'repairing',
    'moving',
    'grabbing',
    'propagating'
]);

const QUEUE_IMPORT_PENDING = new Set(['completed', 'seeding', 'seeding (no peers)', 'queued to seed']);
export const SEEDING = new Set(['seeding', 'seeding (no peers)', 'queued to seed']);

type QueueClass = 'active' | 'importPending' | 'fault' | 'indeterminate';

/**
 * Anything not recognised as active or import-pending is a fault, including
 * statuses this module has never seen: silence is not evidence of health.
 *
 * One exception. The literal `"unknown"` is not something a download client
 * reports — it is our own adapters' fallback for a status code they could not
 * map. That is the service saying something unclassifiable, so it is
 * `indeterminate` rather than a fault.
 */
export function classifyQueueStatus(item: QueueItem): QueueClass {
    if (item.errorMessage !== undefined) return 'fault';
    const status = item.status.toLowerCase();
    if (QUEUE_IMPORT_PENDING.has(status)) return 'importPending';
    if (QUEUE_ACTIVE.has(status)) return 'active';
    if (status === 'unknown') return 'indeterminate';
    return 'fault';
}

/** Priority order when more than one row in the same queue matches the item: a fault outranks everything (something is actively broken), then an unimported completion, then genuine progress, then a row this module cannot even classify. */
const QUEUE_CLASS_PRIORITY: readonly QueueClass[] = ['fault', 'importPending', 'active', 'indeterminate'];

function pickQueueRow(mine: readonly QueueItem[]): { row: QueueItem; cls: QueueClass } {
    for (const cls of QUEUE_CLASS_PRIORITY) {
        const row = mine.find(q => classifyQueueStatus(q) === cls);
        if (row !== undefined) return { row, cls };
    }
    // Unreachable: classifyQueueStatus always returns one of the classes
    // above, and every call site already checked `mine.length > 0`.
    const row = mine[0] as QueueItem;
    return { row, cls: classifyQueueStatus(row) };
}

/** What the item's own *arr is called in a remedy: an artist's is Lidarr, which a film's grab never goes through. */
const arrOf = (item: MergedItem): string => (item.kind === 'artist' ? 'Lidarr' : 'Radarr/Sonarr');

const queueFaultRemedy = (item: MergedItem): string =>
    `Check the download client for the failed grab — retry it, remove it, or fix what it reports (e.g. connectivity to the indexer or news server), then let ${arrOf(item)} search again.`;
const queueImportRemedy = (item: MergedItem): string =>
    `The download finished but has not been imported yet — check ${arrOf(item)}’s activity/history for why, then trigger the import manually if it did not run on its own.`;

/** The download clients `queue` evidence can come from, so `degraded` folds
 *  into "could not fully look" the way `scan` and `indexers` already do. */
const QUEUE_SERVICES: readonly ServiceId[] = ['radarr', 'sonarr', 'whisparr', 'sabnzbd', 'nzbget', 'transmission', 'qbittorrent'];

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
    const claimed = new Map<string, QueueItem>();
    for (const row of rows) {
        const key = keyOf(row);
        if (row.mediaId !== undefined && key !== undefined && !claimed.has(key)) claimed.set(key, row);
    }
    return rows.filter(row => {
        const direct = byId(row);
        if (direct !== undefined) return direct;
        const key = row.mediaId === undefined ? keyOf(row) : undefined;
        const linked = key === undefined ? undefined : claimed.get(key);
        return (linked === undefined ? undefined : byId(linked)) ?? mentions(row.title, item);
    });
}

type QueueResult = { step: Step; remedy?: string; next?: NextStep };

const STRIKE_KIND: Record<string, string> = {
    StalledStrike: ' for stalling',
    FailedImportStrike: ' for failed imports',
    SlowSpeedStrike: ' for being slow',
    SlowTimeStrike: ' for being slow',
    DownloadingMetadataStrike: ' for stuck metadata',
    DeadTorrentStrike: ' as a dead torrent',
    ErroredStrike: ' for a client error'
};

/** Only a strike on this row's own download counts. */
function strikeNoteFor(row: QueueItem, events: Evidence['cleanuparr']): string {
    const rowId = (row.downloadId ?? row.torrent?.hash)?.toLowerCase();
    const strikes = rowId === undefined ? undefined : currentStrikes(events ?? []).get(rowId);
    if (strikes === undefined) return '';
    const each = strikes.map(s => `${s.count} strikes${STRIKE_KIND[s.rawEvent] ?? ''}${s.dryRun === true ? ' (dry run)' : ''}`);
    return ` ${each.join(', ')} from Cleanuparr so far.`;
}

/** Radarr, Sonarr and Lidarr import a download by id. Whisparr has no manual import, so a call to it would be refused and is never offered. */
const IMPORTERS: readonly string[] = ['radarr', 'sonarr', 'lidarr'];

/**
 * The *arr that should import this row: its own service when it is one, since a
 * title match can pick up another instance's grab. Only a download client's row
 * (no media id) falls back to the item's managing service: an *arr row that
 * cannot import is another service's grab, not this item's.
 */
function importerFor(row: QueueItem, item: MergedItem): string | undefined {
    return [row.service, row.mediaId === undefined ? item.acquisition?.service : undefined].find(
        (s): s is string => s !== undefined && IMPORTERS.includes(instanceArgs(s).service)
    );
}

/**
 * The import to offer for a grab whose download has finished. Built from a row
 * that carries a download id and not from the row that was picked: a torrent
 * client's row has none, and sorts ahead of the *arr's.
 */
function importStep(mine: readonly QueueItem[], item: MergedItem): NextStep | undefined {
    const pending = mine.filter(q => classifyQueueStatus(q) === 'importPending' && q.downloadId !== undefined);
    const source = pending.find(q => q.mediaId !== undefined) ?? pending[0];
    const importer = source === undefined ? undefined : importerFor(source, item);
    if (source?.downloadId === undefined || importer === undefined) return undefined;
    return {
        tool: 'trigger_scan',
        arguments: { ...instanceArgs(importer), action: 'import', download_id: source.downloadId },
        why: `Asks ${importer} to import the finished download.`
    };
}

/**
 * A download that is stopped or paused, or whose import is pending on another
 * row of the same grab, is finished rather than failed. Removing it deletes the
 * only copy of the files, so the import is offered instead.
 */
function importIsBehind(row: QueueItem, mine: readonly QueueItem[]): boolean {
    if (['stopped', 'paused'].includes(row.status.toLowerCase())) return true;
    const key = downloadKey(row);
    return key !== undefined && mine.some(q => q !== row && classifyQueueStatus(q) === 'importPending' && downloadKey(q) === key);
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
    const effectivePartial = [...new Set([...partial, ...ev.degraded.filter(s => services.some(t => s === t || s.startsWith(`${t}/`)))])];
    const mine = queueRowsFor(items, item);
    // A file on disk means whatever Cleanuparr removed was replaced since.
    const removals = item.acquisition?.hasFile === true ? [] : (ev.cleanuparr ?? []).filter(e => e.event === 'deleted' || e.event === 'stopped');
    const acted = removals.find(e => e.dryRun !== true) ?? removals[0];

    if (mine.length === 0) {
        // A row for this item could be sitting on the client that failed
        // to answer — a partial read cannot rule that out, so this is
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
    const strikeNote = strikeNoteFor(row, ev.cleanuparr);

    if (cls === 'fault') {
        const next: NextStep | undefined = importIsBehind(row, mine)
            ? importStep(mine, item)
            : {
                  tool: 'remove_queue_item',
                  arguments: { ...instanceArgs(row.service), id: row.id },
                  why: `Removes the failed download from ${row.service} and deletes its partial data. It is not blocklisted.`
              };
        return {
            ...(next === undefined ? {} : { next }),
            step: {
                stage: 'queue',
                service: row.service,
                status: 'blocked',
                detail: `Download ${row.status}${row.errorMessage === undefined ? '' : `: ${row.errorMessage}`}.${strikeNote}`
            },
            remedy: queueFaultRemedy(item)
        };
    }

    // A torrent still seeding a file that is already in the library has nothing left to import.
    if (cls === 'importPending' && item.acquisition?.hasFile === true && SEEDING.has(row.status.toLowerCase())) {
        return {
            step: {
                stage: 'queue',
                service: row.service,
                status: strikeNote === '' ? 'ok' : 'warning',
                detail: `Seeding, and the file is already imported.${strikeNote}`
            }
        };
    }

    if (cls === 'importPending') {
        const next = importStep(mine, item);
        return {
            step: { stage: 'queue', service: row.service, status: 'blocked', detail: `Downloaded, but not yet imported by ${row.service}.${strikeNote}` },
            remedy: queueImportRemedy(item),
            ...(next === undefined ? {} : { next })
        };
    }

    if (cls === 'indeterminate') {
        // The row exists and mentions the item, but neither this module nor
        // the adapter that read it knows what its status means — reported
        // as could-not-classify — not folded into "active", which would claim
        // progress there is no basis for, nor "fault", which would name a
        // problem it cannot.
        return {
            step: {
                stage: 'queue',
                service: row.service,
                status: 'unknown',
                detail: `${row.service} reports a status ("${row.status}") this module does not recognise.`
            }
        };
    }

    const eta = row.etaSeconds === undefined ? '' : ` — about ${Math.round(row.etaSeconds / 60)} minute(s) left`;
    // A download genuinely in progress is not a fault: there is nothing to
    // fix, so no remedy — see QueueResult's optional `remedy`.
    return { step: { stage: 'queue', service: row.service, status: 'blocked', detail: `Still downloading${eta}.${strikeNote}` } };
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
        return {
            stage: 'indexers',
            service: first.service,
            status: 'blocked',
            detail: `${mine.length} recent indexer failure(s), most recently ${first.indexer} on ${first.service}: ${first.reason}.`
        };
    }

    // Nothing matched, but part of the answer is missing — the rejection that
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
    if (ev.libraryDegraded.includes(server)) {
        // Never "it is not in the library" when the library was not asked. Reads
        // `libraryDegraded`, not `degraded`: a failed scan probe belongs to the
        // latter and must not land here, because this stage is about the
        // library *read*. `presence` alone is not enough of a guard either —
        // `unknown` looks like "no evidence at all" to the check below, while
        // `hasFile` is real *arr data this module must not reinterpret.
        return { stage: 'library', service: server, status: 'unknown', detail: `${server} could not be reached, so its library was not checked.` };
    }
    // An artist's presence comes from the music read, which fails, and is absent,
    // on its own. `unknown` is "never looked", so the file-on-disk branch below
    // would claim the server cannot see an artist it was never asked about.
    if (item.kind === 'artist' && item.presence === 'unknown') {
        return ev.libraryDegraded.includes(`${server}:music`)
            ? { stage: 'library', service: server, status: 'unknown', detail: `${server}’s music library could not be read, so whether it has this artist was not checked.` }
            : SKIPPED('library', `${server} does not report a music library here, so whether it has this artist is not known.`);
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
        // probe silently erased a library read that had succeeded — they are
        // independent endpoints and may disagree about what the server answered.
        return { stage: 'scan', service: server, status: 'unknown', detail: `${server} could not be reached, so its scan state was not checked.` };
    }
    if (ev.scan === undefined) return { stage: 'scan', service: server, status: 'unknown', detail: `${server}’s scan state could not be read.` };
    if (ev.scan.running === true) return { stage: 'scan', service: server, status: 'blocked', detail: 'A library scan is running now — check again once it finishes.' };
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
    resolve: 'Try search_media — it also looks at what you do not have yet — or request it through Seerr.',
    request: 'Approve or re-submit the request in Seerr.',
    managed: 'Add it to Radarr or Sonarr, or turn monitoring on for it.',
    indexers: 'Check the indexer in Prowlarr; get_indexers shows its recent failures.'
    // `queue` is evidence-dependent (see queueStep's QueueResult), `file` is
    // step-status-dependent (see fileRemedy), and `library`/`scan` need the
    // configured server's name (see libraryRemedy) — none of the three
    // belong in a static per-stage map.
};

/** Nothing here adds music (lookup_media and add_media read Radarr and Sonarr), so adding the artist is done in Lidarr. */
const ARTIST_MANAGED_REMEDY = 'Add it to Lidarr, or turn monitoring on for it.';

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
 * asserted "no indexer reported a failure" unconditionally — printed directly
 * beneath the summary's own "Could not check: queue, prowlarr".
 *
 * `'skipped'` alone cannot tell "not configured" from "checked and found
 * nothing", since both steps return it for either. So the *configured* flags
 * decide "not configured" and `'unknown'` decides "unreachable"; a service
 * gets credit for being checked only when neither applies.
 */
function fileRemedy(service: string, ev: Evidence, queueStatus: StepStatus, indexerStatus: StepStatus, item: MergedItem): string {
    const uncheckable: string[] = [];
    if (!ev.queueConfigured) uncheckable.push('no download client is configured');
    else if (queueStatus === 'unknown') uncheckable.push('the download client(s) could not be fully checked');
    if (!ev.prowlarrConfigured) uncheckable.push('no indexer manager is configured');
    else if (indexerStatus === 'unknown') uncheckable.push('Prowlarr could not be reached');

    // This server has no Lidarr search to call, so an artist is searched for in
    // Lidarr's own interface rather than with a tool.
    const search = item.kind === 'artist' ? `Search in ${service} itself, which this server cannot search for you` : `Trigger a search in ${service}`;
    if (uncheckable.length === 0) {
        return `${search} — nothing is downloading and no indexer reported a failure.`;
    }
    return `${search} (${uncheckable.join(' and ')}, so that could not be ruled out).`;
}

/**
 * A queue row can be genuinely blocked while `file` is still `ok` — a failing
 * upgrade grab, say. That must not outrank a green chain, but going silent
 * about a real failure over-corrects: it is worth a mention, not the verdict.
 *
 * The wording changes on `fileIsOk`, rather than being suppressed by it
 * (a review finding's second symptom). A `request`/`managed`
 * verdict with genuinely no file yet (`monitored: false` *and*
 * `hasFile: false`) and a faulted queue row used to go silent about that
 * fault entirely — "…is not monitored." with a "turn monitoring on" remedy
 * that is not just incomplete but actively wrong, while the real cause
 * (`queueResult.step.detail`, e.g. "Download failed: news server refused")
 * sat discarded. `fileIsOk` still decides *which sentence*: true asserts a
 * file already exists ("does not block the file already on disk"), which
 * would be a fabricated claim when there is no file — false instead flags
 * the fault as the plausible actual cause of the verdict above it.
 */
const queueAside = (queueResult: QueueResult, fileIsOk: boolean): string => {
    if (queueResult.remedy === undefined || queueResult.step.status !== 'blocked') return '';
    return fileIsOk
        ? ` (Also: ${queueResult.step.detail} This does not block the file already on disk, but may be worth checking.)`
        : ` (Also: ${queueResult.step.detail} There is no file on disk yet, so this may be the actual cause — worth checking before assuming the remedy above will fix it.)`;
};

/**
 * A disclosure, not a fix. Evidence genuinely cannot tell "an ended series
 * deliberately left unmonitored" from "an ongoing one accidentally
 * unmonitored", so this says so rather than guessing.
 *
 * Only for `request`/`managed` verdicts on a series with a file already
 * visible in the configured media server — a movie in that position is
 * excluded upstream, so "episodes you do not have yet" is always literally
 * true here.
 */
const seriesFileVisibleHedge = (server: string, item: MergedItem): string =>
    ` (A file is already on disk and visible in ${server} — this may only affect ${item.kind === 'artist' ? 'albums' : 'episodes'} you do not have yet.)`;

/**
 * The top-level `Diagnosis.degraded` a caller sees, and the input to the
 * `resolve` verdict's own certainty below, are both "everything this
 * diagnosis could not fully check" — the union of probe reachability and
 * library-read reachability. The two are kept separate for the per-stage
 * checks above, which each care about only one; nothing downstream of here
 * needs the distinction.
 */
const allDegraded = (ev: Evidence): string[] => [...new Set([...ev.degraded, ...ev.libraryDegraded])].sort();

/**
 * The same union, minus source-scoped ids (`gather.ts`'s `servicesOnly`) — the
 * input to the `resolve` verdict's certainty, which is a claim about whether a
 * *service* could be asked.
 *
 * No stage of this chain reads `seasons`, so a failed `jellyfin:seasons` read
 * says nothing about whether a title exists or where it is stuck. Counted, it
 * made every diagnose verdict on a stack with a broken episode endpoint report
 * `certain: false` — hedging eight stages against a hole in none of them. The
 * top-level `degraded` still lists it: naming what did not answer is honest,
 * doubting an unrelated verdict over it is not.
 */
const certaintyDegraded = (ev: Evidence): string[] => servicesOnly(allDegraded(ev));

const withSteps = (next: NextStep[]): { next_steps?: NextStep[] } => (next.length === 0 ? {} : { next_steps: next });

/**
 * Only the caller's own words go into a lookup: when the target was an id, the
 * only text to hand over is a service's title, which stays out of arguments.
 */
const lookupStep = (query: string, byWords: boolean): NextStep[] =>
    byWords ? [{ tool: 'lookup_media', arguments: { query }, why: 'Checks whether it exists anywhere before adding it.' }] : [];

/** The monitoring call for an item a service has but is not monitoring. Radarr has no `setMonitoring`, so it goes through `update_media`. */
function monitorStep(acquisition: NonNullable<MergedItem['acquisition']>, item: MergedItem): NextStep[] {
    if (acquisition.id === undefined) return [];
    const target = instanceArgs(acquisition.service);
    // Lidarr's artist level takes a list, and its plan refuses an `id` there.
    if (item.kind === 'artist') {
        return [
            {
                tool: 'set_monitoring',
                arguments: { ...target, level: 'artist', artists: [acquisition.id], monitored: true },
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
        for (const stage of DISPLAY_ORDER.slice(1)) steps.push(SKIPPED(stage, 'Not reached — the item was never identified.'));

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
                        : 'Nothing manages it now, so nothing will grab it again. If you still want it, find it with lookup_media and add it with add_media; get_history shows the full trail.',
                // Not knowing about it and not being able to look are different
                // answers, and a degraded library service means the second —
                // whether the library read itself failed or a diagnose probe did.
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
    // all, regardless of `monitored` — a file can exist on disk even when
    // monitoring is off, and the check below needs that real signal to
    // tell "not monitored, and also no file" apart from "not monitored, but
    // it is sitting right there".
    if (acquisition === undefined) {
        // Not a list of the two *arrs, because the stack may run a third:
        // this is the branch where nothing configured claims the item, and
        // naming services that were never asked reads as a claim they were.
        steps.push({ stage: 'managed', status: 'blocked', detail: 'Nothing configured here is managing it.' });
        steps.push(SKIPPED('file', 'Not reached — nothing is managing it.'));
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
    // file is sitting right there — from here only the media server's
    // visibility of it matters.
    const fileIsOk = byStage.get('file')?.status === 'ok';
    const libStep = byStage.get('library');
    // The guard for `seriesFileVisibleHedge`, below: a file confirmed on
    // disk *and* confirmed visible in the media server, independent of which
    // verdict stage the file/library steps themselves ended up producing.
    const libraryConfirmedOk = fileIsOk && libStep?.status === 'ok';
    // `fileIsOk` means something different for a series than for a movie.
    // A movie's `hasFile` is unambiguous: this exact file is or is not on
    // disk. A series' `hasFile` (`sonarr.ts`: `episodeFileCount > 0`) is
    // "any episode has a file" — true for a show sitting on seasons 1-4
    // while season 5, the actual question, has never arrived. Excluding
    // request/managed there would silently drop the single most common
    // series diagnosis — "monitoring got turned off" / "the new-season
    // request is still pending" — under a confident "is available in
    // <server> and playable", with no remedy and no mention. So the
    // exclusion applies only where the signal it depends on is actually
    // unambiguous: movies.
    const excludeRequestManaged = fileIsOk && item.kind === 'movie';

    let verdictStage: Stage | undefined;
    let certaintyPath: Stage[];

    if (!excludeRequestManaged && isBlocked('request')) {
        verdictStage = 'request';
        certaintyPath = ['request'];
    } else if (!excludeRequestManaged && isBlocked('managed')) {
        verdictStage = 'managed';
        certaintyPath = ['request', 'managed'];
    } else if (isBlocked('file')) {
        // A missing file is a symptom, not the cause: a stalled download or
        // a dead indexer is — but only reached here because `file` is
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
        // Only reachable with `fileIsOk` true — `libraryStep` can only
        // report `blocked` when `acquisition.hasFile === true`, which is
        // exactly `file`'s own `ok` condition. request/managed are excluded
        // above, and correctly so: a scan explains a blocked library, and
        // an unknown scan costs certainty even when library alone would
        // have been enough to verdict on) both apply here.
        verdictStage = isBlocked('scan') ? 'scan' : 'library';
        certaintyPath = ['file', 'library', 'scan'];
    } else {
        verdictStage = undefined; // playable
        certaintyPath = excludeRequestManaged ? ['file', 'library'] : ['request', 'managed', 'file', 'library'];
    }

    const unchecked = certaintyPath.filter(s => byStage.get(s)?.status === 'unknown');
    const certain = unchecked.length === 0;

    const caveat = certain
        ? ''
        : ` Could not check: ${[...new Set(unchecked.map(s => byStage.get(s)?.service ?? s))].join(', ')}.`;
    // `fileIsOk` still decides which of the two `queueAside` sentences
    // applies (see its own doc comment) — it no longer decides whether one
    // appears at all. A confirmed file is what lets the true wording say
    // "does not block the file already on disk"; its absence gets the
    // "may be the actual cause" wording instead, not silence.
    const aside = queueAside(queueResult, fileIsOk) + cleanupAside(ev, byStage.get('file')?.detail);

    if (verdictStage === undefined) {
        // The positive claim "is available in <server> and playable" is only
        // honest when `library` itself said `ok` — read the step, not just
        // whether a media server is configured: `certain: false` alone does
        // not retract an unqualified sentence sitting right next to it.
        // The third branch is reachable only when `library` was skipped for
        // having no server (see `libraryStep`) — `file` being blocked would
        // have taken a different verdict branch otherwise — so it echoes
        // `libraryStep`'s own wording rather than inventing a second one.
        // `hasFile` on an artist is any track at all, which is nowhere near
        // "playable": the albums are one read down and may hold none.
        const summary =
            item.kind === 'artist'
                ? `${item.title} has tracks on disk. ${libStep?.detail ?? ''} That only means at least one track is there: get_media_details lists its albums and which of them have files.${caveat}${aside}`
                : libStep?.status === 'ok'
                  ? `${item.title} is available in ${ev.mediaServer} and playable.${caveat}${aside}`
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
    const remedy =
        blocking.stage === 'queue'
            ? queueResult.remedy
            : blocking.stage === 'file'
              // The `file` step always carries the managing service: it is only
              // pushed on the branch where `acquisition` is defined.
              ? wholeRemoval(ev.cleanup, ev.lastImportAt) !== undefined && acquisition?.hasFile === false
                  ? `A cleanup rule removed it on purpose. Protect it in ${ev.cleanup?.service ?? 'the cleanup service'} first, or the same rule will remove it again, then search for it in ${blocking.service as string}.`
                  : fileRemedy(
                        blocking.service as string,
                        ev,
                        byStage.get('queue')?.status ?? 'unknown',
                        byStage.get('indexers')?.status ?? 'unknown',
                        item
                    )
              : blocking.stage === 'library' || blocking.stage === 'scan'
                ? libraryRemedy(blocking.stage, ev.mediaServer as string)
                : blocking.stage === 'managed' && item.kind === 'artist'
                  ? ARTIST_MANAGED_REMEDY
                  : REMEDIES[blocking.stage];
    // The verdict's own stage is never also the aside (it is already the
    // headline), so `aside` only ever adds information here for a
    // non-queue verdict — same guard as the playable branch above.
    const summaryAside = blocking.stage === 'queue' ? '' : aside;
    const next = nextStepsFor(blocking.stage, { ev, query, byWords, queueNext: queueResult.next });
    // Item 3's first symptom: a `request`/`managed` verdict outranking a
    // library that is genuinely, confirmedly fine (`libraryConfirmedOk`) used
    // to leave that fact sitting unmentioned in `steps`, nowhere in the
    // summary a caller actually reads. Only `request`/`managed` — `file`,
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
        case 'request':
            return ev.request?.status === 'pending' && ev.request.id !== undefined && ev.request.mayRespond === true
                ? [
                      {
                          tool: 'respond_to_request',
                          arguments: { id: String(ev.request.id), verdict: 'approve' },
                          why: 'Approving hands the request to Radarr or Sonarr to search for it.'
                      }
                  ]
                : [];
        case 'managed':
            // Nothing here looks up or adds music, so an artist nothing manages has no lookup to offer.
            if (item === undefined || acquisition === undefined) return item?.kind === 'artist' ? [] : lookupStep(query, byWords);
            return monitorStep(acquisition, item);
        case 'file':
            // Lidarr has no search trigger: trigger_search refuses it.
            if (item?.kind === 'artist') return [];
            if (acquisition?.id === undefined ||(!acquisition.hasFile && wholeRemoval(ev.cleanup, ev.lastImportAt) !== undefined)) return [];
            return [
                {
                    tool: 'trigger_search',
                    arguments: { ...instanceArgs(acquisition.service), id: acquisition.id },
                    why: `Searches ${acquisition.service} for the missing file.${
                        ev.cleanupUnread === undefined
                            ? ''
                            : ` ${ev.cleanupUnread} could not be read, so check it for a cleanup rule before searching again.`
                    }`
                }
            ];
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
    return latest === undefined || (lastImportAt !== undefined && lastImportAt > latest.at) ? undefined : latest;
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
