import type { ServiceId } from '../../config/schema.ts';
import { normaliseTitle } from '../../core/titleMatch.ts';
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

/**
 * Whether a release name (a queue row's title, a rejection's query) plausibly
 * refers to `item`. Built on the shared `normaliseTitle` — the fence-stripping,
 * lowercasing, leading-article rules `search_media` and the resolver already
 * use — rather than a second, divergent copy of it.
 *
 * Two failure modes this specifically guards against:
 * - **Substring matching.** "Alien" is a substring of "Aliens", and "Dune" of
 *   "Dune.Part.Two" — different films. Matching whole, normalised words
 *   closes the first; a differing year in the haystack closes the second
 *   (title match without a contradicting year is still allowed — an ambiguous
 *   release name is more useful reported than silently dropped).
 * - **A length filter that starves short titles.** "Up", "Se7en" and "Top
 *   Gun" have no word over three characters, so filtering them out (the
 *   previous approach) leaves nothing to match *anything* — every one of
 *   those titles matched no queue row or rejection, ever. All words count.
 */
const mentions = (haystack: string, item: MergedItem): boolean => {
    const words = normaliseTitle(item.title)
        .split(' ')
        .filter(w => w.length > 0);
    if (words.length === 0) return false;

    const hayWords = haystack
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(w => w.length > 0);
    const haySet = new Set(hayWords);
    if (!words.every(w => haySet.has(w))) return false;

    if (item.year !== undefined) {
        const yearInHay = hayWords.find(w => /^(19|20)\d{2}$/.test(w));
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
 */
const QUEUE_ACTIVE = new Set([
    'downloading',
    'queued',
    'queued to verify',
    'verifying',
    'queued to seed',
    'seeding',
    'fetching',
    'checking',
    'extracting',
    'repairing',
    'moving',
    'grabbing'
]);

type QueueClass = 'active' | 'importPending' | 'fault';

/** Anything not explicitly recognised as active or import-pending is a fault: that includes real faults like `failed`/`paused`/`stalled`/`warning`, and anything this module has never seen before — silence is not evidence of health. */
function classifyQueueStatus(item: QueueItem): QueueClass {
    if (item.errorMessage !== undefined) return 'fault';
    const status = item.status.toLowerCase();
    if (status === 'completed') return 'importPending';
    if (QUEUE_ACTIVE.has(status)) return 'active';
    return 'fault';
}

const QUEUE_FAULT_REMEDY =
    'Check the download client for the failed grab — retry it, remove it, or fix what it reports (e.g. connectivity to the indexer or news server), then let Radarr/Sonarr search again.';
const QUEUE_IMPORT_REMEDY =
    'The download finished but has not been imported yet — check Radarr/Sonarr’s activity/history for why, then trigger the import manually if it did not run on its own.';

type QueueResult = { step: Step; remedy?: string };

function queueStep(ev: Evidence, item: MergedItem): QueueResult {
    if (!ev.queueConfigured) return { step: SKIPPED('queue', 'No download client is configured.') };
    if (ev.queue === undefined) return { step: { stage: 'queue', status: 'unknown', detail: 'No download client could be reached.' } };

    const { items, partial } = ev.queue;
    const mine = items.filter(q => mentions(q.title, item));

    if (mine.length === 0) {
        if (partial.length > 0) {
            // A row for this item could be sitting on the client that failed
            // to answer — a partial read cannot rule that out, so this is
            // "could not fully look", not "looked and found nothing".
            return {
                step: {
                    stage: 'queue',
                    status: 'unknown',
                    detail: `${partial.join(', ')} could not be reached, so the queue is only partially known.`
                }
            };
        }
        return { step: SKIPPED('queue', 'Nothing matching it is in any download queue.') };
    }

    const fault = mine.find(q => classifyQueueStatus(q) === 'fault');
    if (fault !== undefined) {
        return {
            step: {
                stage: 'queue',
                service: fault.service,
                status: 'blocked',
                detail: `Download ${fault.status}${fault.errorMessage === undefined ? '' : `: ${fault.errorMessage}`}.`
            },
            remedy: QUEUE_FAULT_REMEDY
        };
    }

    const importPending = mine.find(q => classifyQueueStatus(q) === 'importPending');
    if (importPending !== undefined) {
        return {
            step: {
                stage: 'queue',
                service: importPending.service,
                status: 'blocked',
                detail: `Downloaded, but not yet imported by ${importPending.service}.`
            },
            remedy: QUEUE_IMPORT_REMEDY
        };
    }

    const active = mine[0] as QueueItem;
    const eta = active.etaSeconds === undefined ? '' : ` — about ${Math.round(active.etaSeconds / 60)} minute(s) left`;
    // A download genuinely in progress is not a fault: there is nothing to
    // fix, so no remedy — see QueueResult's optional `remedy`.
    return { step: { stage: 'queue', service: active.service, status: 'blocked', detail: `Still downloading${eta}.` } };
}

function indexerStep(ev: Evidence, item: MergedItem): Step {
    if (!ev.prowlarrConfigured) return SKIPPED('indexers', 'No indexer manager is configured.');
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
    // is configuration-dependent (see fileRemedy) — neither belongs in a
    // static per-stage map.
};

/**
 * `file`'s remedy used to assert "no indexer reported a failure" and "nothing
 * is downloading" unconditionally — a claim about Prowlarr or a download
 * client even when the stack runs neither. Exactly the failure
 * `jellyfinConfigured` exists to prevent for Jellyfin, extended here.
 */
function fileRemedy(ev: Evidence): string {
    const uncheckable: string[] = [];
    if (!ev.queueConfigured) uncheckable.push('no download client is configured');
    if (!ev.prowlarrConfigured) uncheckable.push('no indexer manager is configured');

    if (uncheckable.length === 0) {
        return 'Trigger a search in Radarr or Sonarr — nothing is downloading and no indexer reported a failure.';
    }
    return `Trigger a search in Radarr or Sonarr (${uncheckable.join(' and ')}, so that could not be ruled out).`;
}

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

    if (acquisition === undefined) {
        steps.push({ stage: 'managed', status: 'blocked', detail: 'Neither Radarr nor Sonarr is managing it.' });
        steps.push(SKIPPED('file', 'Not reached — nothing is managing it.'));
    } else if (!acquisition.monitored) {
        steps.push({
            stage: 'managed',
            service: acquisition.service,
            status: 'blocked',
            detail: `${acquisition.service} has it, but it is not monitored.`
        });
        steps.push(SKIPPED('file', 'Not reached — it is not monitored.'));
    } else {
        steps.push({ stage: 'managed', service: acquisition.service, status: 'ok', detail: `Monitored in ${acquisition.service}.` });
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

    // The verdict walks a *tree*, not a flat list: a missing file is a
    // symptom, and a stalled download or a dead indexer is its cause, but
    // that reordering only applies once the file really is missing (C1 — a
    // queue row or a rejection that merely mentions the title, while the
    // file already sits `ok`, is context, not a verdict: a 4K upgrade
    // in flight, or a rejection from before the film ever landed, must not
    // outrank a green chain). Symmetrically, once the library actually is
    // missing it, a scan already running is why, and outranks blaming the
    // library itself (I6). `certaintyPath` mirrors exactly the stages that
    // fed into whichever branch was taken — the ones a hole in would have
    // been able to change this specific answer.
    let verdictStage: Stage | undefined;
    let certaintyPath: Stage[];

    if (isBlocked('request')) {
        verdictStage = 'request';
        certaintyPath = ['request'];
    } else if (isBlocked('managed')) {
        verdictStage = 'managed';
        certaintyPath = ['request', 'managed'];
    } else if (isBlocked('file')) {
        if (isBlocked('queue')) {
            verdictStage = 'queue';
            certaintyPath = ['request', 'managed', 'queue'];
        } else if (isBlocked('indexers')) {
            // queue before indexers: a queue row is live, current evidence
            // about an attempt happening right now; an indexer rejection is
            // drawn from a rolling history that can predate the grab that is
            // actually stuck. When both are present, the live signal wins.
            verdictStage = 'indexers';
            certaintyPath = ['request', 'managed', 'queue', 'indexers'];
        } else {
            verdictStage = 'file';
            certaintyPath = ['request', 'managed', 'queue', 'indexers', 'file'];
        }
    } else if (isBlocked('library')) {
        verdictStage = isBlocked('scan') ? 'scan' : 'library';
        certaintyPath = isBlocked('scan') ? ['request', 'managed', 'file', 'library', 'scan'] : ['request', 'managed', 'file', 'library'];
    } else {
        // Nothing blocked: the candidate verdict is "playable". `library` is
        // still on the path — an unreachable Jellyfin is exactly what must
        // not be papered over by a confident "it is available in Jellyfin"
        // (C2) — but `queue`/`indexers` are not: the file is already `ok`,
        // so whatever is or is not reachable about the download side cannot
        // change that.
        verdictStage = undefined;
        certaintyPath = ['request', 'managed', 'file', 'library'];
    }

    const unchecked = certaintyPath.filter(s => byStage.get(s)?.status === 'unknown');
    const certain = unchecked.length === 0;

    const caveat = certain
        ? ''
        : ` Could not check: ${[...new Set(unchecked.map(s => byStage.get(s)?.service ?? s))].join(', ')}.`;

    if (verdictStage === undefined) {
        const libStep = byStage.get('library');
        // The positive claim "is available in Jellyfin and playable" is only
        // honest when `library` itself said `ok` — read the step, not just
        // whether Jellyfin is configured (C2): `certain: false` alone does
        // not retract an unqualified sentence sitting right next to it.
        const summary =
            libStep?.status === 'ok'
                ? `${item.title} is available in Jellyfin and playable.${caveat}`
                : libStep?.status === 'unknown'
                  ? `${item.title} has a file, but Jellyfin could not be reached to confirm it is visible there.${caveat}`
                  : `${item.title} is on disk. Nothing else to check — Jellyfin is not configured.${caveat}`;

        return {
            query,
            resolved: resolvedOf(item),
            steps,
            verdict: { stage: 'playable', summary, certain },
            degraded: ev.degraded
        };
    }

    const blocking = byStage.get(verdictStage) as Step;
    const remedy = blocking.stage === 'queue' ? queueResult.remedy : blocking.stage === 'file' ? fileRemedy(ev) : REMEDIES[blocking.stage];

    return {
        query,
        resolved: resolvedOf(item),
        steps,
        verdict: {
            stage: blocking.stage,
            summary: `${blocking.detail}${caveat}`,
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
