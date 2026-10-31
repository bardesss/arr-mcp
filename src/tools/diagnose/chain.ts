import type { ServiceId } from '../../config/schema.ts';
import { servicesOnly } from '../../core/gather.ts';
import { unfenced } from '../../core/titleMatch.ts';
import { currentStrikes } from '../cleanuparrQueue.ts';
import type { FilmOrSeries, MergedItem } from '../../core/resolver.ts';
import type { HistoryEntry, IndexerRejection, QueueItem, RequestStatus, ScanState } from '../../services/types.ts';

export type Stage = 'resolve' | 'request' | 'managed' | 'file' | 'queue' | 'indexers' | 'library' | 'scan';
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
    item: FilmOrSeries | undefined;
    request: { status: RequestStatus | 'unknown' } | null | undefined;
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
    resolved?: { title: string; year?: number; kind: 'movie' | 'series'; ids: MergedItem['ids'] };
    steps: Step[];
    verdict: { stage: Stage | 'playable'; summary: string; remedy?: string; certain: boolean };
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
    'scan'
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

function requestStep(ev: Evidence): Step {
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
const SEEDING = new Set(['seeding', 'seeding (no peers)', 'queued to seed']);

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
function classifyQueueStatus(item: QueueItem): QueueClass {
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

const QUEUE_FAULT_REMEDY =
    'Check the download client for the failed grab — retry it, remove it, or fix what it reports (e.g. connectivity to the indexer or news server), then let Radarr/Sonarr search again.';
const QUEUE_IMPORT_REMEDY =
    'The download finished but has not been imported yet — check Radarr/Sonarr’s activity/history for why, then trigger the import manually if it did not run on its own.';

/** The download clients `queue` evidence can come from, so `degraded` folds
 *  into "could not fully look" the way `scan` and `indexers` already do. */
const QUEUE_SERVICES: readonly ServiceId[] = ['radarr', 'sonarr', 'whisparr', 'sabnzbd', 'nzbget', 'transmission', 'qbittorrent'];

type QueueResult = { step: Step; remedy?: string };

const STRIKE_KIND: Record<string, string> = {
    StalledStrike: ' for stalling',
    FailedImportStrike: ' for failed imports',
    SlowSpeedStrike: ' for being slow',
    SlowTimeStrike: ' for being slow',
    DownloadingMetadataStrike: ' for stuck metadata',
    DeadTorrentStrike: ' as a dead torrent'
};

/** Only a strike on this row's own download counts. */
function strikeNoteFor(row: QueueItem, events: Evidence['cleanuparr']): string {
    const rowId = (row.downloadId ?? row.torrent?.hash)?.toLowerCase();
    const strikes = rowId === undefined ? undefined : currentStrikes(events ?? []).get(rowId);
    if (strikes === undefined) return '';
    const each = strikes.map(s => `${s.count} strikes${STRIKE_KIND[s.rawEvent] ?? ''}${s.dryRun === true ? ' (dry run)' : ''}`);
    return ` ${each.join(', ')} from Cleanuparr so far.`;
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
    const effectivePartial = [...new Set([...partial, ...ev.degraded.filter(s => QUEUE_SERVICES.some(t => s === t || s.startsWith(`${t}/`)))])];
    const mine = items.filter(q => mentions(q.title, item));
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
        return {
            step: {
                stage: 'queue',
                service: row.service,
                status: 'blocked',
                detail: `Download ${row.status}${row.errorMessage === undefined ? '' : `: ${row.errorMessage}`}.${strikeNote}`
            },
            remedy: QUEUE_FAULT_REMEDY
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
        return {
            step: { stage: 'queue', service: row.service, status: 'blocked', detail: `Downloaded, but not yet imported by ${row.service}.${strikeNote}` },
            remedy: QUEUE_IMPORT_REMEDY
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
function fileRemedy(service: string, ev: Evidence, queueStatus: StepStatus, indexerStatus: StepStatus): string {
    const uncheckable: string[] = [];
    if (!ev.queueConfigured) uncheckable.push('no download client is configured');
    else if (queueStatus === 'unknown') uncheckable.push('the download client(s) could not be fully checked');
    if (!ev.prowlarrConfigured) uncheckable.push('no indexer manager is configured');
    else if (indexerStatus === 'unknown') uncheckable.push('Prowlarr could not be reached');

    if (uncheckable.length === 0) {
        return `Trigger a search in ${service} — nothing is downloading and no indexer reported a failure.`;
    }
    return `Trigger a search in ${service} (${uncheckable.join(' and ')}, so that could not be ruled out).`;
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
const seriesFileVisibleHedge = (server: string): string =>
    ` (A file is already on disk and visible in ${server} — this may only affect episodes you do not have yet.)`;

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

export function buildChain(query: string, ev: Evidence): Diagnosis {
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
                certain: certaintyDegraded(ev).length === 0
            },
            ...(releases.length === 0 ? {} : { history: releases.map(r => r.row) }),
            degraded: allDegraded(ev)
        };
    }

    const item = ev.item;
    const acquisition = item.acquisition;

    steps.push({ stage: 'resolve', status: 'ok', detail: `Identified as ${item.title}.` });
    steps.push(requestStep(ev));

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
        steps.push(
            acquisition.hasFile
                ? { stage: 'file', service: acquisition.service, status: 'ok', detail: 'A file is on disk.' }
                : { stage: 'file', service: acquisition.service, status: 'blocked', detail: 'No file on disk yet.' }
        );
    }

    const queueResult = queueStep(ev, item);
    steps.push(queueResult.step);
    steps.push(indexerStep(ev, item));
    steps.push(libraryStep(ev, item));
    steps.push(scanStep(ev));

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
    const aside = queueAside(queueResult, fileIsOk);

    if (verdictStage === undefined) {
        // The positive claim "is available in <server> and playable" is only
        // honest when `library` itself said `ok` — read the step, not just
        // whether a media server is configured: `certain: false` alone does
        // not retract an unqualified sentence sitting right next to it.
        // The third branch is reachable only when `library` was skipped for
        // having no server (see `libraryStep`) — `file` being blocked would
        // have taken a different verdict branch otherwise — so it echoes
        // `libraryStep`'s own wording rather than inventing a second one.
        const summary =
            libStep?.status === 'ok'
                ? `${item.title} is available in ${ev.mediaServer} and playable.${caveat}${aside}`
                : libStep?.status === 'unknown'
                  ? `${item.title} has a file, but ${ev.mediaServer} could not be reached to confirm it is visible there.${caveat}${aside}`
                  : `${item.title} is on disk. No media server is configured.${caveat}${aside}`;

        return {
            query,
            resolved: resolvedOf(item),
            steps,
            verdict: { stage: 'playable', summary, certain },
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
              ? fileRemedy(
                    blocking.service as string,
                    ev,
                    byStage.get('queue')?.status ?? 'unknown',
                    byStage.get('indexers')?.status ?? 'unknown'
                )
              : blocking.stage === 'library' || blocking.stage === 'scan'
                ? libraryRemedy(blocking.stage, ev.mediaServer as string)
                : REMEDIES[blocking.stage];
    // The verdict's own stage is never also the aside (it is already the
    // headline), so `aside` only ever adds information here for a
    // non-queue verdict — same guard as the playable branch above.
    const summaryAside = blocking.stage === 'queue' ? '' : aside;
    // Item 3's first symptom: a `request`/`managed` verdict outranking a
    // library that is genuinely, confirmedly fine (`libraryConfirmedOk`) used
    // to leave that fact sitting unmentioned in `steps`, nowhere in the
    // summary a caller actually reads. Only `request`/`managed` — `file`,
    // `queue`, `indexers`, `library` and `scan` are all cases where `library`
    // is either not yet meaningful or is already the point.
    const hedge =
        libraryConfirmedOk && (blocking.stage === 'request' || blocking.stage === 'managed')
            ? seriesFileVisibleHedge(ev.mediaServer as string)
            : '';

    return {
        query,
        resolved: resolvedOf(item),
        steps,
        verdict: {
            stage: blocking.stage,
            summary: `${blocking.detail}${caveat}${hedge}${summaryAside}`,
            ...(remedy === undefined ? {} : { remedy }),
            certain
        },
        degraded: allDegraded(ev)
    };
}

const resolvedOf = (item: FilmOrSeries): NonNullable<Diagnosis['resolved']> => ({
    title: item.title,
    ...(item.year === undefined ? {} : { year: item.year }),
    kind: item.kind,
    ids: item.ids
});
