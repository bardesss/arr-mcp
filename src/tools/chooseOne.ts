import type { ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import type { QualityProfile, RootFolder, Tag } from '../services/types.ts';

/**
 * Resolving a profile, root folder or tag the caller named — shared by
 * `add_media` and `update_media`, which must agree about what "2160p" means.
 *
 * Exact matches are tried first and, crucially, a **loose match that is
 * ambiguous is a refusal, not a coin toss**. Two live failures shaped this:
 *
 * - Asking for quality profile `8` selected `HD-1080p` (id 4), because the
 *   old single predicate `id === requested || name.includes(requested)` let
 *   the *name* branch fire on the digit: "hd-1080p" contains "8". A film was
 *   added and a 1080p release grabbed against an explicit request for 2160p.
 *   A numeric request now only ever matches an id.
 * - `2160p Balanced` is a prefix of `2160p Balanced NL`, so a substring match
 *   silently picked whichever came first.
 *
 * Both are the same failure the "several, none named" refusal below exists to
 * prevent — a guess presented as a decision — and both are worse for arriving
 * while looking like the tool had understood.
 */
export function chooseOne<T>(
    options: readonly T[],
    requested: string | undefined,
    match: { exact: (option: T, requested: string) => boolean; loose: (option: T, requested: string) => boolean },
    describe: (option: T) => string,
    what: string,
    service: ServiceId
): T {
    if (options.length === 0) {
        throw new ServiceError('NotFound', service, `${service} has no ${what} configured`, {
            remedy: `Add one in ${service}'s own settings first — nothing can be added without it.`
        });
    }

    if (requested !== undefined) {
        const exact = options.filter(o => match.exact(o, requested));
        if (exact.length === 1) return exact[0]!;

        // Only consulted when nothing matched exactly, so an exact name can
        // never be beaten by another option that merely contains it.
        const loose = exact.length === 0 ? options.filter(o => match.loose(o, requested)) : exact;
        if (loose.length === 1) return loose[0]!;

        if (loose.length === 0) {
            throw new ServiceError('NotFound', service, `no ${what} on ${service} matches "${requested}"`, {
                remedy: `Available: ${options.map(describe).join('; ')}.`
            });
        }

        throw new ServiceError('NotFound', service, `"${requested}" matches more than one ${what} on ${service}`, {
            remedy: `Be exact — it matches: ${loose.map(describe).join('; ')}. Naming the id is unambiguous.`
        });
    }

    // Exactly one is not a choice, so making it silently is not a guess.
    if (options.length === 1) return options[0]!;

    throw new ServiceError('NotFound', service, `${service} has several ${what}s and none was named`, {
        remedy: `Name one — available: ${options.map(describe).join('; ')}. Not guessing, because the wrong one is not obvious until the download finishes.`
    });
}

/** A request made entirely of digits is an id and nothing else. Without this,
 *  "8" matches the *name* "HD-1080p". */
const isNumeric = (value: string) => /^\d+$/.test(value);

const GIB = 1024 ** 3;
export const freeSpace = (folder: RootFolder): string =>
    folder.freeSpaceBytes === undefined ? 'free space unknown' : `${(folder.freeSpaceBytes / GIB).toFixed(0)} GB free`;

export const PROFILE_MATCH = {
    exact: (p: QualityProfile, requested: string): boolean =>
        String(p.id) === requested || p.name.toLowerCase() === requested.toLowerCase(),
    // A numeric request is an id, full stop — never a substring of a name.
    loose: (p: QualityProfile, requested: string): boolean =>
        !isNumeric(requested) && p.name.toLowerCase().includes(requested.toLowerCase())
};

/** Tags are single words, so a substring match would let "kid" hit "kids"
 *  and "kids-tv" at once — which `chooseOne` then refuses. Exact or id. */
export const TAG_MATCH = {
    exact: (t: Tag, requested: string): boolean =>
        String(t.id) === requested || t.label.toLowerCase() === requested.toLowerCase(),
    loose: (t: Tag, requested: string): boolean =>
        !isNumeric(requested) && t.label.toLowerCase().includes(requested.toLowerCase())
};

export const FOLDER_MATCH = {
    exact: (f: RootFolder, requested: string): boolean => f.path.toLowerCase() === requested.toLowerCase(),
    loose: (f: RootFolder, requested: string): boolean => f.path.toLowerCase().includes(requested.toLowerCase())
};
