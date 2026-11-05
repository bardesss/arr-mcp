import { logger } from '../core/logger.ts';
import type { ExternalIds, MergedItem } from '../core/resolver.ts';
import {
    hasCleanup,
    hasQueue,
    hasRequests,
    type CleanupStatus,
    type MediaRequest,
    type QueueItem,
    type ServiceAdapter
} from '../services/types.ts';
import { classifyQueueStatus, queueRowsFor, SEEDING, wholeRemoval } from './diagnose/chain.ts';
import { findRequest } from './diagnose/evidence.ts';
import { removalSentence, upcomingSentence } from './cleanupStatus.ts';
import type { LibraryLoader } from './library.ts';

/**
 * Which questions a write asks of the rest of the stack before it is confirmed.
 * `delete` asks whether something else still depends on the title; `acquire`
 * asks whether something else is working against getting it.
 */
export type CrossCheckProfile = 'delete' | 'acquire';

export type CrossCheckSubject = {
    kind: 'movie' | 'series';
    /** How the title reads in a warning. Already fenced if it came from a service. */
    label: string;
    ids: ExternalIds;
    acquisition?: { service: string; id: string };
    /** delete_episode_files only: the seasons being deleted. */
    seasons?: number[];
};

/**
 * `warnings` are findings; `unchecked` names the services that could not be
 * asked. They are separate because an empty `warnings` means "looked and found
 * nothing" only for a service that is not in `unchecked`.
 */
export type Advice = { warnings: string[]; unchecked: string[] };

/** Never rejects: advice is the extra, and the preview is the answer. */
export type CrossChecker = (subject: CrossCheckSubject, profile: CrossCheckProfile) => Promise<Advice>;

/** One budget for the whole check, not one per read: a preview should not wait longest when most services are down. */
export const CROSS_CHECK_BUDGET_MS = 5000;

const TIMED_OUT = Symbol('timed out');

const NO_TMDB = (service: string): string => `${service} (no TMDB id)`;

export function buildCrossChecker(adapters: readonly ServiceAdapter[], library: LibraryLoader): CrossChecker {
    // `find`, as `diagnose` does, so a second instance cannot make the two disagree.
    const seerr = adapters.find(hasRequests);
    const reclaimerr = adapters.find(hasCleanup);
    // Without Lidarr's artist queue, as in `diagnose`: an unreachable Lidarr
    // would otherwise leave every film "only partially checked".
    const queueAdapters = adapters
        .filter(hasQueue)
        .filter(a => a.queueKind === undefined || a.queueKind === 'movie' || a.queueKind === 'series');

    return async (subject, profile) => {
        const warnings: string[] = [];
        const unchecked = new Set<string>();

        // Cleared in `finally`: a live timer would keep the process, or a test
        // run, waiting for up to the full budget after the answer was ready.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const expired = new Promise<typeof TIMED_OUT>(resolve => {
            timer = setTimeout(() => resolve(TIMED_OUT), CROSS_CHECK_BUDGET_MS);
        });

        // `undefined` is "could not look", which is why every failure lands in
        // `unchecked` and never in `warnings`.
        const read = async <T>(id: string, fn: () => Promise<T>): Promise<T | undefined> => {
            try {
                const out = await Promise.race([fn(), expired]);
                if (out !== TIMED_OUT) return out;
                logger.warn({ service: id }, 'cross-check read ran out of time; the preview will say it was not checked');
            } catch (err) {
                logger.warn({ service: id, err }, 'cross-check read failed; the preview will say it was not checked');
            }
            unchecked.add(id);
            return undefined;
        };

        try {
            const { label } = subject;

            // The library fills in what the subject's own ids lack (a Sonarr
            // record has a TVDB id and no TMDB one), and `delete` reads watch
            // state from it. A miss or a failure falls back to the subject's ids.
            const wantsIds =
                subject.ids.tmdb === undefined &&
                (reclaimerr !== undefined || (seerr !== undefined && subject.ids.tvdb === undefined));
            const needsLibrary = profile === 'delete' || wantsIds;
            const snapshot = needsLibrary ? await read('library', () => library.load()) : undefined;
            const found = snapshot?.index.find(subject.ids, subject.kind);
            const ids: ExternalIds = {
                ...subject.ids,
                ...(subject.ids.tmdb === undefined && found?.ids.tmdb !== undefined ? { tmdb: found.ids.tmdb } : {}),
                ...(subject.ids.tvdb === undefined && found?.ids.tvdb !== undefined ? { tvdb: found.ids.tvdb } : {})
            };

            const requestsP: Promise<MediaRequest[] | undefined> =
                seerr === undefined
                    ? Promise.resolve(undefined)
                    : ids.tmdb === undefined && ids.tvdb === undefined
                      ? Promise.resolve(undefined).then(() => void unchecked.add(NO_TMDB(seerr.id)))
                      : read(seerr.id, () => seerr.getRequests({}));
            const tmdb = ids.tmdb;
            const cleanupP: Promise<CleanupStatus | undefined> =
                reclaimerr === undefined
                    ? Promise.resolve(undefined)
                    : tmdb === undefined
                      ? Promise.resolve(undefined).then(() => void unchecked.add(NO_TMDB(reclaimerr.id)))
                      : read(reclaimerr.id, () => reclaimerr.readCleanupStatus(subject.kind, tmdb));
            const queueP: Promise<QueueItem[]> = Promise.all(
                queueAdapters.map(a => read(a.id, () => a.getQueue()))
            ).then(lists => lists.flatMap(rows => rows ?? []));

            const [requests, cleanup, queue] = await Promise.all([requestsP, cleanupP, queueP]);

            const request = requests === undefined ? undefined : findRequest(requests, ids);
            const acquisition = subject.acquisition ?? found?.acquisition;
            // The library's title when there is one: `mentions` tokenises it,
            // and a label carrying fence markers or a year would not match a release.
            const item: MergedItem = {
                kind: subject.kind,
                title: found?.title ?? label,
                ...(found?.year === undefined ? {} : { year: found.year }),
                ids,
                presence: 'unknown',
                ...(acquisition === undefined
                    ? {}
                    : {
                          acquisition: {
                              service: acquisition.service,
                              ...(acquisition.id === undefined ? {} : { id: acquisition.id }),
                              monitored: false,
                              hasFile: false
                          }
                      })
            };
            const mine = queueRowsFor(queue, item);
            const where = (rows: QueueItem[]): string => [...new Set(rows.map(r => r.service))].join(', ');

            if (profile === 'delete') {
                if (request !== undefined) {
                    warnings.push(`Seerr still has a request for ${label}. This write does not remove it; delete_request does.`);
                }
                if ((cleanup?.protections.length ?? 0) > 0 && cleanup !== undefined) {
                    warnings.push(`${cleanup.service} has an active protection on ${label}.`);
                }
                const downloading = mine.filter(r => classifyQueueStatus(r) === 'active');
                if (downloading.length > 0) warnings.push(`${label} is still downloading in ${where(downloading)}.`);
                const seeding = mine.filter(r => SEEDING.has(r.status.toLowerCase()));
                if (seeding.length > 0) {
                    warnings.push(
                        `${label} is still seeding in ${where(seeding)}, so deleting it may not free the disk space if the files are hardlinked.`
                    );
                }
                if (found?.playback?.watched === false) {
                    warnings.push(`${label} has not been watched yet by the default user.`);
                }
                // `=== false`, not `!== true`: `complete` is absent when either
                // half of the join is missing, and "unknown" is not "unwatched".
                const unwatched = (subject.seasons ?? []).filter(
                    n => found?.seasons?.find(s => s.season === n)?.complete === false
                );
                if (unwatched.length > 0) {
                    warnings.push(`${label} season ${unwatched.join(', ')} has not been fully watched yet.`);
                }
            } else {
                if (cleanup !== undefined) {
                    const removal = wholeRemoval(cleanup, undefined);
                    const sentences = [
                        removal === undefined ? undefined : removalSentence(cleanup.service, removal),
                        upcomingSentence(cleanup.service, cleanup.candidates)
                    ].filter((s): s is string => s !== undefined);
                    if (sentences.length > 0) {
                        warnings.push(`${sentences.join(' ')} Protect ${label} in ${cleanup.service} first, or it may be removed again.`);
                    }
                }
                if (request?.status === 'pending') {
                    warnings.push(`The Seerr request for ${label} is still waiting for approval.`);
                } else if (request?.status === 'declined') {
                    warnings.push(`The Seerr request for ${label} was declined.`);
                }
                const active = mine.filter(r => classifyQueueStatus(r) === 'active');
                if (active.length > 0) warnings.push(`${label} is already downloading in ${where(active)}.`);
            }

            return { warnings, unchecked: [...unchecked].sort() };
        } catch (err) {
            // Advice is the extra and the preview is the answer, so a bug here must not cost the preview.
            logger.warn({ err }, 'cross-checks failed; the preview will say they were not run');
            return { warnings: [], unchecked: ['cross-service checks'] };
        } finally {
            clearTimeout(timer);
        }
    };
}
