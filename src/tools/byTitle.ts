import type { FilmOrSeries } from '../core/resolver.ts';
import type { ServiceAdapter } from '../services/types.ts';
import { buildResolvedMediaDetails, explainMiss, NotInLibrary, type ResolvedMediaDetails } from './getMediaDetails.ts';
import type { LibraryLoader } from './library.ts';
import { titled } from '../core/labels.ts';

/**
 * A title in place of an id, for the tools that act on one item.
 *
 * Without it every "mark Breaking Bad season 1 watched" took two calls: one to
 * get_media_details for the id, one to do it (#518's eval). The resolution is
 * the one get_media_details uses, so a title means the same item to both.
 *
 * Unlike get_media_details, a tie is refused rather than answered with the best
 * guess: these tools write or search, and acting on the wrong one of two
 * equally good matches is worse than one more call. The refusal names every
 * match with its id, so that call needs no further lookup. Titles stay fenced
 * in every message here: they are the services' text, not ours.
 */
export async function itemByTitle(adapters: readonly ServiceAdapter[], loader: LibraryLoader, title: string): Promise<FilmOrSeries> {
    let found: ResolvedMediaDetails;
    try {
        found = await buildResolvedMediaDetails(loader, title);
    } catch (err) {
        if (err instanceof NotInLibrary) throw await explainMiss(adapters, err);
        throw err;
    }
    if (found.ambiguous === true) {
        const all = [found, ...(found.candidates ?? [])].map(
            c =>
                titled(c.title, c.year) +
                (c.acquisition?.id === undefined ? '' : ` (${c.acquisition.service} id ${c.acquisition.id})`)
        );
        throw new Error(`"${title}" matches more than one title equally well: ${all.join('; ')}. Name the one you mean by its id instead.`);
    }
    return found;
}

/** The managing service's id for a title, from the instance the call names. */
export async function managedIdByTitle(
    adapters: readonly ServiceAdapter[],
    loader: LibraryLoader,
    title: string,
    adapterId: string
): Promise<string> {
    const item = await itemByTitle(adapters, loader, title);
    const label = titled(item.title, item.year);
    if (item.acquisition?.service !== adapterId || item.acquisition.id === undefined) {
        throw new Error(
            item.acquisition === undefined
                ? `${label} is in your media server, but no service manages it, so ${adapterId} has no id for it.`
                : `${label} is managed by ${item.acquisition.service}, not ${adapterId}.`
        );
    }
    return item.acquisition.id;
}

/**
 * The Jellyfin item id for a title. With two media servers the merged record's
 * `playback` is the primary's, so Jellyfin's own id is read from
 * `media_servers` whenever that is there.
 */
export async function jellyfinIdByTitle(adapters: readonly ServiceAdapter[], loader: LibraryLoader, title: string): Promise<string> {
    const item = await itemByTitle(adapters, loader, title);
    const id = item.media_servers === undefined ? item.playback?.itemId : item.media_servers['jellyfin']?.itemId;
    if (id === undefined) {
        throw new Error(`${titled(item.title, item.year)} is not in Jellyfin, so there is no watch state to set.`);
    }
    return id;
}
