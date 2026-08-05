import type { ServiceId } from '../../config/schema.ts';
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
    queue: QueueItem[] | undefined;
    rejections: IndexerRejection[] | undefined;
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

/**
 * The verdict is chosen in a *different* order, and the difference is the one
 * judgement call in this module: **a missing file is a symptom, and a stalled
 * download or a dead indexer is its cause**. Answering "it has no file" when
 * the real answer is "your news server is refusing connections" is technically
 * true and useless.
 */
const VERDICT_ORDER: readonly Stage[] = [
    'resolve',
    'request',
    'managed',
    'queue',
    'indexers',
    'file',
    'library',
    'scan'
];

const SKIPPED = (stage: Stage, detail: string): Step => ({ stage, status: 'skipped', detail });

/** Words a title and a release name are likely to share, after normalisation. */
const mentions = (haystack: string, item: MergedItem): boolean => {
    const words = item.title
        .replace(/^<<untrusted:[^>]*>>/, '')
        .replace(/<<\/untrusted>>$/, '')
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(w => w.length > 3);
    if (words.length === 0) return false;

    const hay = haystack.toLowerCase();
    return words.every(w => hay.includes(w));
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
    return { stage: 'request', service: 'seerr', status: 'ok', detail: `The request is ${ev.request.status}.` };
}

function queueStep(ev: Evidence, item: MergedItem): Step {
    if (ev.queue === undefined) return { stage: 'queue', status: 'unknown', detail: 'No download client could be reached.' };

    const mine = ev.queue.filter(q => mentions(q.title, item));
    if (mine.length === 0) return SKIPPED('queue', 'Nothing matching it is in any download queue.');

    const failed = mine.find(q => q.errorMessage !== undefined || /stall|fail|error|paused/i.test(q.status));
    if (failed !== undefined) {
        return {
            stage: 'queue',
            service: failed.service,
            status: 'blocked',
            detail: `Download ${failed.status}${failed.errorMessage === undefined ? '' : `: ${failed.errorMessage}`}.`
        };
    }

    const active = mine[0] as QueueItem;
    const eta = active.etaSeconds === undefined ? '' : ` — about ${Math.round(active.etaSeconds / 60)} minute(s) left`;
    return { stage: 'queue', service: active.service, status: 'blocked', detail: `Still downloading${eta}.` };
}

function indexerStep(ev: Evidence, item: MergedItem): Step {
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
    if (ev.scan === undefined) return { stage: 'scan', service: 'jellyfin', status: 'unknown', detail: 'Jellyfin’s scan state could not be read.' };
    if (ev.scan.running === true) return { stage: 'scan', service: 'jellyfin', status: 'blocked', detail: 'A library scan is running now — check again once it finishes.' };
    if (ev.scan.lastCompleted === undefined) return { stage: 'scan', service: 'jellyfin', status: 'unknown', detail: 'Jellyfin reports no completed library scan.' };
    return { stage: 'scan', service: 'jellyfin', status: 'ok', detail: `Last library scan completed ${ev.scan.lastCompleted}.` };
}

const REMEDIES: Partial<Record<Stage, string>> = {
    resolve: 'Try search_media — it also looks at what you do not have yet — or request it through Seerr.',
    request: 'Approve or re-submit the request in Seerr.',
    managed: 'Add it to Radarr or Sonarr, or turn monitoring on for it.',
    file: 'Trigger a search in Radarr or Sonarr — nothing is downloading and no indexer reported a failure.',
    indexers: 'Check the indexer in Prowlarr; get_indexers shows its recent failures.',
    library: 'Trigger a Jellyfin library scan. If it still does not appear, check the path is inside a Jellyfin library and readable by it.',
    scan: 'Wait for the running scan, or start one from Jellyfin’s dashboard.'
};

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

    steps.push(queueStep(ev, item));
    steps.push(indexerStep(ev, item));
    steps.push(libraryStep(ev, item));
    steps.push(scanStep(ev));

    const byStage = new Map(steps.map(s => [s.stage, s]));
    const verdictStage = VERDICT_ORDER.find(s => byStage.get(s)?.status === 'blocked');
    const blocking = verdictStage === undefined ? undefined : (byStage.get(verdictStage) as Step);

    // Any stage that could not be checked *before* the verdict leaves a hole
    // the verdict reads across. Stages after it cannot change the answer.
    const cutoff = verdictStage === undefined ? DISPLAY_ORDER.length : VERDICT_ORDER.indexOf(verdictStage);
    const unchecked = VERDICT_ORDER.slice(0, cutoff).filter(s => byStage.get(s)?.status === 'unknown');
    const certain = unchecked.length === 0;

    const caveat = certain
        ? ''
        : ` Could not check: ${[...new Set(unchecked.map(s => byStage.get(s)?.service ?? s))].join(', ')}.`;

    if (blocking === undefined) {
        return {
            query,
            resolved: resolvedOf(item),
            steps,
            verdict: {
                stage: 'playable',
                summary: ev.jellyfinConfigured
                    ? `${item.title} is available in Jellyfin and playable.${caveat}`
                    : `${item.title} is on disk. Nothing else to check — Jellyfin is not configured.${caveat}`,
                certain
            },
            degraded: ev.degraded
        };
    }

    const remedy = REMEDIES[blocking.stage];
    // A download in progress is not a fault, so there is nothing to suggest.
    const suggest = blocking.stage === 'queue' && !/stall|fail|error|paused/i.test(blocking.detail) ? undefined : remedy;

    return {
        query,
        resolved: resolvedOf(item),
        steps,
        verdict: {
            stage: blocking.stage,
            summary: `${blocking.detail}${caveat}`,
            ...(suggest === undefined ? {} : { remedy: suggest }),
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
