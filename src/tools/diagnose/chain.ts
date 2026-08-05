import type { ServiceId } from '../../config/schema.ts';
import { unfenced } from '../../core/titleMatch.ts';
import type { MergedItem } from '../../core/resolver.ts';
import type { IndexerRejection, QueueItem, RequestStatus, ScanState } from '../../services/types.ts';

export type Stage = 'resolve' | 'request' | 'managed' | 'file' | 'queue' | 'indexers' | 'library' | 'scan';
export type StepStatus = 'ok' | 'blocked' | 'unknown' | 'skipped';

export type Step = { stage: Stage; service?: ServiceId; status: StepStatus; detail: string };

/**
 * `undefined` and `null` mean different things throughout, and the distinction
 * is the whole of §6.1: **undefined is "could not look", null is "looked and
 * found nothing"**. Collapsing them is how a diagnosis becomes confidently
 * wrong about a service that was down.
 */
export type Evidence = {
    item: MergedItem | undefined;
    request: { status: RequestStatus | 'unknown' } | null | undefined;
    /**
     * A multi-service stage: `items` is whatever the collector actually read
     * (from however many of Radarr/Sonarr/SABnzbd/Transmission answered),
     * `partial` names the ones that didn't. A single unreachable client used
     * to erase the whole stage to `undefined`, discarding rows another
     * client *did* return — including the stalled row that was the actual
     * cause. `undefined` still means every configured client failed.
     */
    queue: { items: QueueItem[]; partial: ServiceId[] } | undefined;
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
    degraded: ServiceId[];
};

export type Diagnosis = {
    query: string;
    resolved?: { title: string; year?: number; kind: 'movie' | 'series'; ids: MergedItem['ids'] };
    steps: Step[];
    verdict: { stage: Stage | 'playable'; summary: string; remedy?: string; certain: boolean };
    degraded: ServiceId[];
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

/** Splits on runs of non-alphanumerics, exactly the way a release name's dots/dashes/spaces are treated — both sides of `mentions()` must tokenise identically, or a title survives round-tripping through `normaliseTitle`'s punctuation-*deletion* differently than a haystack split on the same punctuation (N3). */
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
 * Whether a release name (a queue row's title, a rejection's query) plausibly
 * refers to `item`.
 *
 * Three failure modes this specifically guards against:
 * - **Substring matching.** "Alien" is a substring of "Aliens", and "Dune" of
 *   "Dune.Part.Two" — different films. Matching whole, tokenised words closes
 *   the first; a differing year in the haystack closes the second (title
 *   match without a contradicting year is still allowed — an ambiguous
 *   release name is more useful reported than silently dropped).
 * - **A length filter that starves short titles.** "Up", "Se7en" and "Top
 *   Gun" have no word over three characters; a filter that drops short words
 *   (the original approach) leaves nothing to match *anything*. All words
 *   count, however short.
 * - **Punctuation deletion vs. punctuation splitting (N3, a round-1
 *   regression).** `normaliseTitle` *deletes* intra-word punctuation
 *   ("Spider-Man" → "spiderman"), while a release name is naturally *split*
 *   on the same characters ("Spider.Man.2002" → "spider", "man", "2002").
 *   Deleting on one side and splitting on the other means neither ever
 *   produces the same tokens: `tokenize` splits both sides identically.
 */
const mentions = (haystack: string, item: MergedItem): boolean => {
    const words = titleWords(item);
    if (words.length === 0) return false;

    const hayWords = tokenize(haystack);
    const haySet = new Set(hayWords);
    if (!words.every(w => haySet.has(w))) return false;

    // A series release's year is an episode's air year/date, not the series'
    // start year — "The.Simpsons.S32E01.2020" is not a mismatch just because
    // the show started in 1989 (N4). Skip the guard entirely for series.
    if (item.kind !== 'series' && item.year !== undefined) {
        // A token that is itself part of the title ("2049" in "Blade Runner
        // 2049", "1917" as a whole title, "2001" in "2001: A Space Odyssey")
        // must not be read as *the release's* year — it is already accounted
        // for by the word match above. Only a year-shaped token that is not
        // one of the title's own words is a candidate (N4).
        const wordSet = new Set(words);
        const yearInHay = hayWords.find(w => /^(19|20)\d{2}$/.test(w) && !wordSet.has(w));
        if (yearInHay !== undefined && Number(yearInHay) !== item.year) return false;
    }

    return true;
};

function requestStep(ev: Evidence): Step {
    if (ev.request === undefined) return { stage: 'request', service: 'seerr', status: 'unknown', detail: 'Seerr could not be reached.' };
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
 * Explicit, not a regex over free text: `/stall|fail|error|paused/i` reads
 * `completed` — a download waiting on Radarr/Sonarr to import it, which *is*
 * the broken import this phase exists to surface — as "still downloading",
 * because the word "complete" contains none of those substrings. It misreads
 * `downloadClientUnavailable`, and Radarr/Sonarr's own `warning`/`delay`, the
 * same way. Status vocabulary is collected from what the adapters actually
 * emit: Radarr/Sonarr's queue (`queued`, `paused`, `downloading`, `completed`,
 * `failed`, `warning`, `delay`, `downloadClientUnavailable`), Transmission's
 * RPC spec, and SABnzbd's slot status, all lowercased before matching here.
 *
 * `seeding` / `queued to seed` (Transmission) mean the torrent itself
 * finished — the file is fully on disk, same as Radarr/Sonarr's `completed`
 * — so they classify as import-pending, not active (N5). `propagating`
 * (SABnzbd, the file is being finalised/verified post-download — healthy)
 * stays active (N6).
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
 * Anything not explicitly recognised as active or import-pending is a fault
 * — that includes real faults like `failed`/`paused`/`stalled`/`warning`,
 * and anything this module has never seen before — silence is not evidence
 * of health.
 *
 * One exception (N6, by I5's own reasoning): the literal string `"unknown"`
 * is not a status a download client actually reports — it is *this repo's
 * own adapters'* fallback (`SabnzbdAdapter`'s `s.status ?? 'unknown'`,
 * `TransmissionAdapter`'s `TORRENT_STATUS[...] ?? 'unknown'`) for a status
 * code they could not map. That is the service answering with something
 * this module cannot classify — `indeterminate`, not a fault, exactly as an
 * indeterminate Seerr request status is `unknown`, not silently `ok` (I5).
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

/** The download-client services `queue` evidence can come from — used to fold `degraded` into "could not fully look" the same way `library`/`scan` already do (N8). */
const QUEUE_SERVICES: readonly ServiceId[] = ['radarr', 'sonarr', 'sabnzbd', 'transmission'];

type QueueResult = { step: Step; remedy?: string };

function queueStep(ev: Evidence, item: MergedItem): QueueResult {
    if (!ev.queueConfigured) return { step: SKIPPED('queue', 'No download client is configured.') };
    if (ev.queue === undefined) return { step: { stage: 'queue', status: 'unknown', detail: 'No download client could be reached.' } };

    const { items, partial } = ev.queue;
    // A service already named in `degraded` is unreachable even if the
    // collector's per-stage `partial` list did not separately say so (N8) —
    // the same reachability signal `libraryStep`/`scanStep` read for Jellyfin.
    const effectivePartial = [...new Set([...partial, ...ev.degraded.filter(s => QUEUE_SERVICES.includes(s))])];
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
        // as could-not-fully-classify, not silently folded into "active"
        // (which would claim progress this module has no basis for) or
        // "fault" (which would claim a problem it cannot name) (N6).
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
        // Same reachability signal `libraryStep` reads for Jellyfin — closes
        // the gap where only library/scan consulted `degraded` (N8).
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
    if (ev.degraded.includes('jellyfin')) {
        // Never "it is not in Jellyfin" when Jellyfin was not asked (§6.1).
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
        // Same reachability signal `libraryStep` reads — a Jellyfin that could
        // not be asked about its library could not be asked about its scan
        // state either, and the two should not be able to disagree about that.
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
 * `file`'s remedy used to assert "no indexer reported a failure" and "nothing
 * is downloading" unconditionally — a claim about Prowlarr or a download
 * client even when the stack runs neither, *or* when it runs both but
 * neither answered (N2: the summary's own caveat says "Could not check:
 * queue, prowlarr" right next to a remedy asserting they were checked).
 *
 * `StepStatus: 'skipped'` alone cannot tell "not configured" apart from
 * "configured, reachable, and genuinely found nothing" — `queueStep`/
 * `indexerStep` return the same status for both, with only their `detail`
 * text differing. So the *configured* flags decide "not configured", and
 * `status === 'unknown'` (only reachable when configured) decides
 * "unreachable"; only when neither applies does a service get credit for
 * having actually been checked.
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
 * A queue row can be genuinely blocked (a fault, or a completed-but-unimported
 * download) while `file` is still `ok` — an upgrade grab failing, say. C1
 * correctly stops that from outranking a green chain, but going silent about
 * a real, active failure is over-correction in the other direction (N7): it
 * is worth a mention, just not the verdict.
 */
const queueAside = (queueResult: QueueResult): string =>
    queueResult.remedy === undefined || queueResult.step.status !== 'blocked'
        ? ''
        : ` (Also: ${queueResult.step.detail} This does not block the file already on disk, but may be worth checking.)`;

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
                // answers, and a degraded library service means the second.
                certain: ev.degraded.length === 0
            },
            degraded: ev.degraded
        };
    }

    const item = ev.item;
    const acquisition = item.acquisition;

    steps.push({ stage: 'resolve', status: 'ok', detail: `Identified as ${item.title}.` });
    steps.push(requestStep(ev));

    // `file` is now computed whenever Radarr/Sonarr knows about the item at
    // all, regardless of `monitored` — a file can exist on disk even when
    // monitoring is off, and residual-C1 needs that real signal (below) to
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
    // A file already confirmed on disk is proof that whatever request/managed
    // history led here already worked well enough to produce it — residual
    // C1: an old declined/pending request, or `monitored: false`, cannot be
    // why playback fails when the file is sitting right there. From this
    // point on only Jellyfin's visibility of that file matters.
    const fileIsOk = byStage.get('file')?.status === 'ok';

    let verdictStage: Stage | undefined;
    let certaintyPath: Stage[];

    if (!fileIsOk && isBlocked('request')) {
        verdictStage = 'request';
        certaintyPath = ['request'];
    } else if (!fileIsOk && isBlocked('managed')) {
        verdictStage = 'managed';
        certaintyPath = ['request', 'managed'];
    } else if (isBlocked('file')) {
        // A missing file is a symptom, not the cause: a stalled download or
        // a dead indexer is (C1) — but only reached here because `file` is
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
        // above, and correctly so: I6 (scan explains a blocked library) and
        // N1 (an unknown scan costs certainty even when library alone would
        // have been enough to verdict on) both apply here.
        verdictStage = isBlocked('scan') ? 'scan' : 'library';
        certaintyPath = ['file', 'library', 'scan'];
    } else {
        verdictStage = undefined; // playable
        certaintyPath = fileIsOk ? ['file', 'library'] : ['request', 'managed', 'file', 'library'];
    }

    const unchecked = certaintyPath.filter(s => byStage.get(s)?.status === 'unknown');
    const certain = unchecked.length === 0;

    const caveat = certain
        ? ''
        : ` Could not check: ${[...new Set(unchecked.map(s => byStage.get(s)?.service ?? s))].join(', ')}.`;
    const aside = queueAside(queueResult);

    if (verdictStage === undefined) {
        const libStep = byStage.get('library');
        // The positive claim "is available in Jellyfin and playable" is only
        // honest when `library` itself said `ok` — read the step, not just
        // whether Jellyfin is configured (C2): `certain: false` alone does
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
            degraded: ev.degraded
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

    return {
        query,
        resolved: resolvedOf(item),
        steps,
        verdict: {
            stage: blocking.stage,
            summary: `${blocking.detail}${caveat}${summaryAside}`,
            ...(remedy === undefined ? {} : { remedy }),
            certain
        },
        degraded: ev.degraded
    };
}

const resolvedOf = (item: MergedItem): NonNullable<Diagnosis['resolved']> => ({
    title: item.title,
    ...(item.year === undefined ? {} : { year: item.year }),
    kind: item.kind,
    ids: item.ids
});
