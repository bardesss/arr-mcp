import * as z from 'zod/v4';
import type { LibraryKind } from '../core/resolver.ts';
import type { QueueCapable, ServiceAdapter } from '../services/types.ts';

/**
 * The `kind` a read can be narrowed to, worded once for every tool that takes
 * it: get_library already did, and a model that asked about Radarr had no way
 * to say so to lookup_media, so it got Lidarr's artists and Shelfmark's books
 * ranked above the film (one "Paranormal Activity" lookup, three follow-up
 * calls to find the film itself).
 */
export const MediaKindSchema = z
    .enum(['movie', 'series', 'artist', 'book'])
    .optional()
    .describe('Only films, series (Sonarr, Whisparr), Lidarr artists or books. Omit for all. Services that hold none of that kind are not asked.');

/**
 * What a service holds, when it says. The *arrs, Shelfmark and Grimmory
 * declare it as `queueKind`; Seerr, the media servers, Prowlarr and the
 * download clients hold more than one kind, or none, and answer `undefined`.
 */
export const heldKind = (a: ServiceAdapter): LibraryKind | undefined => (a as Partial<QueueCapable>).queueKind;

/**
 * The services worth asking about `kind`: every one, without a kind; with one,
 * those that hold it plus those that do not say. A service that holds a
 * different kind is left out before the call, not filtered after it, so
 * narrowing also saves the request.
 */
export const mayHold = (a: ServiceAdapter, kind: LibraryKind | undefined): boolean => {
    if (kind === undefined) return true;
    const held = heldKind(a);
    return held === undefined || held === kind;
};

/**
 * As `mayHold`, but a service that does not say is left out too. For the
 * queue: a download client's rows are the same downloads the *arr already
 * lists, so asking about films drops them rather than mixing in music.
 */
export const holds = (a: ServiceAdapter, kind: LibraryKind | undefined): boolean => kind === undefined || heldKind(a) === kind;
