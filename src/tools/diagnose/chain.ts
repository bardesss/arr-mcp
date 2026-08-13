import type { ServiceId } from '../../config/schema.ts';
import { servicesOnly } from '../../core/gather.ts';
import { unfenced } from '../../core/titleMatch.ts';
import type { MergedItem } from '../../core/resolver.ts';
import type { IndexerRejection, QueueItem, RequestStatus, ScanState } from '../../services/types.ts';

export type Stage = 'resolve' | 'request' | 'managed' | 'file' | 'queue' | 'indexers' | 'library' | 'scan';
export type StepStatus = 'ok' | 'blocked' | 'unknown' | 'skipped';

export type Step = { stage: Stage; service?: string; status: StepStatus; detail: string };

/**
 * `undefined` and `null` mean different things throughout, and the distinction
 * is the whole of **undefined is "could not look", null is "looked and
 * found nothing"**. Collapsing them is how a diagnosis becomes confidently
 * wrong about a service that was down.
 */
export type Evidence = {
    item: MergedItem | undefined;
    request: { status: RequestStatus | 'unknown' } | null | undefined;
    /**
     * `items` is what the collector actually read, `partial` names the clients
     * that did not answer. One unreachable client used to erase the whole stage,
     * discarding rows another client did return — including the stalled row that
     * was the cause. `undefined` still means every client failed.
     */
    queue: { items: QueueItem[]; partial: string[] } | undefined;
    /** Analogue of `jellyfinConfigured`, below: no download client at all, not merely unreachable. */
    queueConfigured: boolean;
    rejections: IndexerRejection[] | undefined;
    /** Analogue of `jellyfinConfigured`: no Prowlarr configured, not merely unreachable. */
    prowlarrConfigured: boolean;
    scan: ScanState | undefined;
    /**
     * A third state beyond looked/could-not-look: **never configured**. Without
     * it, a stack with no Jellyfin gets "Jellyfin cannot see it" — a claim
     * about a service the user does not run.
     */
    jellyfinConfigured: boolean;
    /**
     * Library-read reachability, separate from `degraded` below, which is
     * *probe* reachability. A service can fail one without the other: a failing
     * Jellyfin `getScanState` must not erase a library read that succeeded, and
     * a failing Radarr library read must not make `queueStep` call every queue
     * unknown. Only `libraryStep` reads this; every other step reads `degraded`.
     */
    libraryDegraded: readonly string[];
    degraded: readonly string[];
};

export type Diagnosis = {
    query: string;
    resolved?: { title: string; year?: number; kind: 'movie' | 'series'; ids: MergedItem['ids'] };
    steps: Step[];
    verdict: { stage: Stage | 'playable'; summary: string; remedy?: string; certain: boolean };
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
const mentions = (haystack: string, item: MergedItem): boolean => {
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
 * The vocabulary is what the adapters actually emit, lowercased. `seeding` and
 * `queued to seed` mean the file is fully on disk, so they are import-pending
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

const QUEUE_IMPORT_PENDING = new Set(['completed', 'seeding', 'queued to seed']);

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
const QUEUE_SERVICES: readonly ServiceId[] = ['radarr', 'sonarr', 'sabnzbd', 'transmission'];

type QueueResult = { step: Step; remedy?: string };

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

    if (mine.length === 0) {
        if (effectivePartial.length > 0) {
            // A row for this item could be sitting on the client that failed
            // to answer — a partial read cannot rule that out, so this is
            // "could not fully look", not "looked and found nothing".
            return {
                step: {
                    stage: 'queue',
                    status: 'unknown',
                    detail: `${effectivePartial.join(', ')} could not be reached, so the queue is only partially known.`
                }
            };
        }
        return { step: SKIPPED('queue', 'Nothing matching it is in any download queue.') };
    }

    const { row, cls } = pickQueueRow(mine);

    if (cls === 'fault') {
        return {
            step: {
                stage: 'queue',
                service: row.service,
                status: 'blocked',
                detail: `Download ${row.status}${row.errorMessage === undefined ? '' : `: ${row.errorMessage}`}.`
            },
            remedy: QUEUE_FAULT_REMEDY
        };
    }

    if (cls === 'importPending') {
        return {
            step: { stage: 'queue', service: row.service, status: 'blocked', detail: `Downloaded, but not yet imported by ${row.service}.` },
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
    return { step: { stage: 'queue', service: row.service, status: 'blocked', detail: `Still downloading${eta}.` } };
}

function indexerStep(ev: Evidence, item: MergedItem): Step {
    if (!ev.prowlarrConfigured) return SKIPPED('indexers', 'No indexer manager is configured.');
    if (ev.degraded.includes('prowlarr')) {
        // `degraded` is probe reachability — the same array `scanStep` and
        // `queueStep` read, and right here too: Prowlarr contributes no
        // library-read half, so there is no `libraryDegraded` for it to consult
        // instead. A service's own probe failing must count even when
        // `rejections` happens to be defined from a stale read.
        return { stage: 'indexers', service: 'prowlarr', status: 'unknown', detail: 'Prowlarr could not be reached.' };
    }
    if (ev.rejections === undefined) return { stage: 'indexers', service: 'prowlarr', status: 'unknown', detail: 'Prowlarr could not be reached.' };

    const mine = ev.rejections.filter(r => (r.query === undefined ? false : mentions(r.query, item)));
    if (mine.length === 0) return SKIPPED('indexers', 'No recent indexer failures mention it.');

    const first = mine[0] as IndexerRejection;
    return {
        stage: 'indexers',
        service: 'prowlarr',
        status: 'blocked',
        detail: `${mine.length} recent indexer failure(s), most recently ${first.indexer}: ${first.reason}.`
    };
}

function libraryStep(ev: Evidence, item: MergedItem): Step {
    if (!ev.jellyfinConfigured) return SKIPPED('library', 'Jellyfin is not configured.');
    if (ev.libraryDegraded.includes('jellyfin')) {
        // Never "it is not in Jellyfin" when Jellyfin was not asked. Reads
        // `libraryDegraded`, not `degraded`: a failed scan probe belongs to the
        // latter and must not land here, because this stage is about the
        // library *read*. `presence` alone is not enough of a guard either —
        // `unknown` looks like "no evidence at all" to the check below, while
        // `hasFile` is real *arr data this module must not reinterpret.
        return { stage: 'library', service: 'jellyfin', status: 'unknown', detail: 'Jellyfin could not be reached, so its library was not checked.' };
    }
    if (item.presence === 'both' || item.presence === 'jellyfin_only') {
        return { stage: 'library', service: 'jellyfin', status: 'ok', detail: 'Present in the Jellyfin library.' };
    }
    if (item.acquisition?.hasFile === true) {
        return {
            stage: 'library',
            service: 'jellyfin',
            status: 'blocked',
            detail: `${item.acquisition.service} has a file on disk that Jellyfin cannot see.`
        };
    }
    return SKIPPED('library', 'Not in Jellyfin, and there is no file for it to have found.');
}

function scanStep(ev: Evidence): Step {
    if (!ev.jellyfinConfigured) return SKIPPED('scan', 'Jellyfin is not configured.');
    if (ev.degraded.includes('jellyfin')) {
        // Specifically the `getScanState` probe, and deliberately not
        // `libraryDegraded`. The two once shared an array, so a failed scan
        // probe silently erased a library read that had succeeded — they are
        // independent endpoints and may disagree about what Jellyfin answered.
        return { stage: 'scan', service: 'jellyfin', status: 'unknown', detail: 'Jellyfin could not be reached, so its scan state was not checked.' };
    }
    if (ev.scan === undefined) return { stage: 'scan', service: 'jellyfin', status: 'unknown', detail: 'Jellyfin’s scan state could not be read.' };
    if (ev.scan.running === true) return { stage: 'scan', service: 'jellyfin', status: 'blocked', detail: 'A library scan is running now — check again once it finishes.' };
    if (ev.scan.lastCompleted === undefined) return { stage: 'scan', service: 'jellyfin', status: 'unknown', detail: 'Jellyfin reports no completed library scan.' };
    return { stage: 'scan', service: 'jellyfin', status: 'ok', detail: `Last library scan completed ${ev.scan.lastCompleted}.` };
}

const REMEDIES: Partial<Record<Stage, string>> = {
    resolve: 'Try search_media — it also looks at what you do not have yet — or request it through Seerr.',
    request: 'Approve or re-submit the request in Seerr.',
    managed: 'Add it to Radarr or Sonarr, or turn monitoring on for it.',
    indexers: 'Check the indexer in Prowlarr; get_indexers shows its recent failures.',
    library: 'Trigger a Jellyfin library scan. If it still does not appear, check the path is inside a Jellyfin library and readable by it.',
    scan: 'Wait for the running scan, or start one from Jellyfin’s dashboard.'
    // `queue` is evidence-dependent (see queueStep's QueueResult) and `file`
    // is step-status-dependent (see fileRemedy) — neither belongs in a
    // static per-stage map.
};

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
function fileRemedy(ev: Evidence, queueStatus: StepStatus, indexerStatus: StepStatus): string {
    const uncheckable: string[] = [];
    if (!ev.queueConfigured) uncheckable.push('no download client is configured');
    else if (queueStatus === 'unknown') uncheckable.push('the download client(s) could not be fully checked');
    if (!ev.prowlarrConfigured) uncheckable.push('no indexer manager is configured');
    else if (indexerStatus === 'unknown') uncheckable.push('Prowlarr could not be reached');

    if (uncheckable.length === 0) {
        return 'Trigger a search in Radarr or Sonarr — nothing is downloading and no indexer reported a failure.';
    }
    return `Trigger a search in Radarr or Sonarr (${uncheckable.join(' and ')}, so that could not be ruled out).`;
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
 * visible in Jellyfin — a movie in that position is excluded upstream, so
 * "episodes you do not have yet" is always literally true here.
 */
const SERIES_FILE_VISIBLE_HEDGE =
    ' (A file is already on disk and visible in Jellyfin — this may only affect episodes you do not have yet.)';

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
 * No stage of this chain reads `seasons`, so a failed `jellyfin:episodes` read
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
        steps.push({ stage: 'resolve', status: 'blocked', detail: 'No configured service knows this title.' });
        for (const stage of DISPLAY_ORDER.slice(1)) steps.push(SKIPPED(stage, 'Not reached — the item was never identified.'));

        return {
            query,
            steps,
            verdict: {
                stage: 'resolve',
                summary: `Nothing in your stack matches "${query}".`,
                remedy: REMEDIES.resolve as string,
                // Not knowing about it and not being able to look are different
                // answers, and a degraded library service means the second —
                // whether the library read itself failed or a diagnose probe did.
                certain: certaintyDegraded(ev).length === 0
            },
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
        steps.push({ stage: 'managed', status: 'blocked', detail: 'Neither Radarr nor Sonarr is managing it.' });
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
    // file is sitting right there — from here only Jellyfin's visibility of
    // it matters.
    const fileIsOk = byStage.get('file')?.status === 'ok';
    const libStep = byStage.get('library');
    // The guard for `SERIES_FILE_VISIBLE_HEDGE`, below: a file confirmed on
    // disk *and* confirmed visible in Jellyfin, independent of which verdict
    // stage the file/library steps themselves ended up producing.
    const libraryConfirmedOk = fileIsOk && libStep?.status === 'ok';
    // `fileIsOk` means something different for a series than for a movie.
    // A movie's `hasFile` is unambiguous: this exact file is or is not on
    // disk. A series' `hasFile` (`sonarr.ts`: `episodeFileCount > 0`) is
    // "any episode has a file" — true for a show sitting on seasons 1-4
    // while season 5, the actual question, has never arrived. Excluding
    // request/managed there would silently drop the single most common
    // series diagnosis — "monitoring got turned off" / "the new-season
    // request is still pending" — under a confident "is available in
    // Jellyfin and playable", with no remedy and no mention. So the
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
        // The positive claim "is available in Jellyfin and playable" is only
        // honest when `library` itself said `ok` — read the step, not just
        // whether Jellyfin is configured: `certain: false` alone does
        // not retract an unqualified sentence sitting right next to it.
        const summary =
            libStep?.status === 'ok'
                ? `${item.title} is available in Jellyfin and playable.${caveat}${aside}`
                : libStep?.status === 'unknown'
                  ? `${item.title} has a file, but Jellyfin could not be reached to confirm it is visible there.${caveat}${aside}`
                  : `${item.title} is on disk. Nothing else to check — Jellyfin is not configured.${caveat}${aside}`;

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
              ? fileRemedy(ev, byStage.get('queue')?.status ?? 'unknown', byStage.get('indexers')?.status ?? 'unknown')
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
            ? SERIES_FILE_VISIBLE_HEDGE
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

const resolvedOf = (item: MergedItem): NonNullable<Diagnosis['resolved']> => ({
    title: item.title,
    ...(item.year === undefined ? {} : { year: item.year }),
    kind: item.kind,
    ids: item.ids
});
