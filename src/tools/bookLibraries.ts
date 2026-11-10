import type { ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import type { BookLibrary } from '../services/types.ts';

export const libraryList = (libraries: readonly BookLibrary[]): string =>
    libraries.map(l => `${l.label} (id ${l.id})`).join(', ');

/**
 * The library `library` names. A match is by id or by name, ignoring case, and
 * both count at once: a library named "2" and the library with id 2 are two
 * answers, and two answers is a refusal that lists them, never a pick.
 */
export function resolveBookLibrary(service: ServiceId, libraries: readonly BookLibrary[], wanted: string): BookLibrary {
    const lower = wanted.toLowerCase();
    const matches = libraries.filter(l => l.id === wanted || l.name.toLowerCase() === lower);

    if (matches.length === 1) return matches[0] as BookLibrary;

    if (matches.length > 1) {
        throw new ServiceError('NotFound', service, `"${wanted}" matches ${matches.length} libraries in ${service}`, {
            remedy: `They are ${libraryList(matches)}. Pass the numeric id of the one you mean as \`library\`.`
        });
    }

    throw new ServiceError('NotFound', service, `${service} has no library "${wanted}"`, {
        remedy: libraries.length === 0 ? `${service} has no libraries.` : `Its libraries are ${libraryList(libraries)}. Pass a name or an id.`
    });
}
