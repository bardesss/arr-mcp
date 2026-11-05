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

            // Everything that can start now does, so a slow library cannot
            // spend the shared budget before the other services were asked.
            // The library only gates a read whose ids the subject lacks (a
            // Sonarr record has a TVDB id and no TMDB one).
            const hasSeerrIds = subject.ids.tmdb !== undefined || subject.ids.tvdb !== undefined;
            const wantsIds =
                subject.ids.tmdb === undefined && (reclaimerr !== undefined || (seerr !== undefined && !hasSeerrIds));
            const needsLibrary = profile === 'delete' || wantsIds;
            // A load that resolves is not a load that saw everything: a media
            // server or *arr that was down leaves watch state and ids absent,
            // and absent must not read as "looked and found nothing".
            const snapshotP = needsLibrary
                ? read('library', () => library.load()).then(snap => {
                      for (const id of snap?.degraded ?? []) {
                          if (id !== library.secondaryMediaServerId) unchecked.add(id.replace(/:.*$/, ''));
                      }
                      return snap;
                  })
                : Promise.resolve(undefined);
            const foundP = snapshotP.then(snap => snap?.index.find(subject.ids, subject.kind));
            // A miss or a failure falls back to the subject's own ids.
            const idsFrom = (found: MergedItem | undefined): ExternalIds => ({
                ...subject.ids,
                ...(subject.ids.tmdb === undefined && found?.ids.tmdb !== undefined ? { tmdb: found.ids.tmdb } : {}),
                ...(subject.ids.tvdb === undefined && found?.ids.tvdb !== undefined ? { tvdb: found.ids.tvdb } : {})
            });
            const idsP = foundP.then(idsFrom);

            const askSeerr = (seerrAdapter: NonNullable<typeof seerr>, ids: ExternalIds): Promise<MediaRequest[] | undefined> => {
                if (ids.tmdb === undefined && ids.tvdb === undefined) {
                    unchecked.add(NO_TMDB(seerrAdapter.id));
                    return Promise.resolve(undefined);
                }
                return read(seerrAdapter.id, () => seerrAdapter.getRequests({}));
            };
            const askCleanup = (cleanupAdapter: NonNullable<typeof reclaimerr>, ids: ExternalIds): Promise<CleanupStatus | undefined> => {
                const tmdb = ids.tmdb;
                if (tmdb === undefined) {
                    unchecked.add(NO_TMDB(cleanupAdapter.id));
                    return Promise.resolve(undefined);
                }
                return read(cleanupAdapter.id, () => cleanupAdapter.readCleanupStatus(subject.kind, tmdb));
            };
            const requestsP =
                seerr === undefined
                    ? Promise.resolve(undefined)
                    : hasSeerrIds
                      ? askSeerr(seerr, subject.ids)
                      : idsP.then(ids => askSeerr(seerr, ids));
            const cleanupP =
                reclaimerr === undefined
                    ? Promise.resolve(undefined)
                    : subject.ids.tmdb !== undefined
                      ? askCleanup(reclaimerr, subject.ids)
                      : idsP.then(ids => askCleanup(reclaimerr, ids));
            const queueP: Promise<QueueItem[]> = Promise.all(
                queueAdapters.map(a => read(a.id, () => a.getQueue()))
            ).then(lists => lists.flatMap(rows => rows ?? []));

            const [requests, cleanup, queue, found] = await Promise.all([requestsP, cleanupP, queueP, foundP]);
            const ids = idsFrom(found);

            // Same title, not just same number: TMDB's film and series ids are
            // separate namespaces. Every match is kept, so a pending request
            // is not hidden behind an approved one for the same series.
            const matching = (requests ?? []).filter(
                r =>
                    (r.mediaType === 'unknown' || r.mediaType === (subject.kind === 'movie' ? 'movie' : 'tv')) &&
                    findRequest([r], ids) !== undefined
            );
            const acquisition = subject.acquisition ?? found?.acquisition;
            // A title `mentions` can tokenise: the library's when there is one,
            // otherwise the label without its fence markers and trailing year.
            // A fenced label ends `<</untrusted>> (1979)`, which `unfenced`
            // cannot strip, so the fence and the year would become tokens no
            // release name contains.
            const plain = label.replace(/<<untrusted:[^>]*>>/g, '').replace(/<<\/untrusted>>/g, '').trim();
            const dated = /^(.*\S)\s*\((\d{4})\)$/.exec(plain);
            const year = found?.year ?? (dated?.[2] === undefined ? undefined : Number(dated[2]));
            const item: MergedItem = {
                kind: subject.kind,
                title: found?.title ?? dated?.[1] ?? plain,
                ...(year === undefined ? {} : { year }),
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
                if (matching.length > 0) {
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
                // Not for a season delete: the series row's flag is false while any later season is unwatched.
                if (subject.seasons === undefined && found?.playback?.watched === false) {
                    warnings.push(`${label} has not been watched yet by the default user.`);
                }
                // `=== false`, not `!== true`: `complete` is absent when either
                // half of the join is missing, and "unknown" is not "unwatched".
                const unwatched = (subject.seasons ?? []).filter(
                    n => found?.seasons?.find(s => s.season === n)?.complete === false
                );
                if (unwatched.length > 0) {
                    warnings.push(
                        `${unwatched.length === 1 ? 'Season' : 'Seasons'} ${unwatched.join(', ')} of ${label} ${unwatched.length === 1 ? 'has' : 'have'} not been fully watched yet.`
                    );
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
                if (matching.some(r => r.status === 'pending')) {
                    warnings.push(`The Seerr request for ${label} is still waiting for approval.`);
                } else if (matching.some(r => r.status === 'declined')) {
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
