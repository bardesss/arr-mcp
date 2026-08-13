import type { ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import type { ServiceAdapter } from '../services/types.ts';

/**
 * Which configured instance of a service a call means.
 *
 * Tools open-coded `adapters.find(a => a.id === service)`, which was exactly
 * right while `id` and service type were the same string. With two Radarrs they
 * are not, and that lookup matches *neither* — so this replaces every one of
 * them rather than being added beside them. `diagnose` was missed in that first
 * pass and kept answering "radarr is not configured" about a named Radarr until
 * it was converted too; if you are adding a by-service lookup, it belongs here.
 *
 * The rule that matters is the last one: **several instances and none named is a
 * refusal, not a coin toss.** That is already this codebase's answer to
 * ambiguity, and it was written after a real incident — an ambiguous quality
 * profile match sent a film to 1080p against an explicit 2160p request, and it
 * was only discovered once the download finished (see `addMedia.ts`). Guessing
 * which Radarr receives a 4K release is the same failure with a worse blast
 * radius: the wrong library, the wrong disk, and no error anywhere.
 *
 * Every refusal names the alternatives. A refusal that does not say what to pass
 * instead leaves the model to guess a second time.
 */
export function resolveInstance(
    adapters: readonly ServiceAdapter[],
    type: ServiceId,
    instance?: string | undefined
): ServiceAdapter {
    // `.type`, never `.id` — `id` is `radarr/4k` for a named instance, so
    // matching on it is what broke.
    const candidates = adapters.filter(a => a.type === type);

    if (candidates.length === 0) {
        throw new ServiceError('NotFound', type, `${type} is not configured`, {
            remedy: `Add a services.${type} block to config.yaml, or name a configured service.`
        });
    }

    if (instance !== undefined && instance !== '') {
        const wanted = instance.toLowerCase();
        const found = candidates.find(a => (a.instance ?? '').toLowerCase() === wanted);
        if (found !== undefined) return found;

        throw new ServiceError('NotFound', type, `${type} has no instance named "${instance}"`, {
            remedy: `Configured ${type} instances: ${nameList(candidates)}.`
        });
    }

    if (candidates.length === 1) return candidates[0] as ServiceAdapter;

    throw new ServiceError(
        'NotFound',
        type,
        `${type} has ${candidates.length} instances configured, so "${type}" alone does not say which`,
        {
            remedy: `Pass instance with one of: ${nameList(candidates)}. Guessing risks acting on the wrong library.`
        }
    );
}

/** The names as the caller would pass them — bare, not qualified, because
 *  `instance` takes `4k` rather than `radarr/4k`. */
const nameList = (adapters: readonly ServiceAdapter[]): string =>
    adapters
        .map(a => (a.instance === undefined ? '(unnamed)' : `"${a.instance}"`))
        .sort()
        .join(', ');

/**
 * Every instance of a service, for reads that span them.
 *
 * Someone runs a 4K Radarr so that their library is the union of both. A read
 * that demanded to know which half to look in would have defeated the point, so
 * reads fan out and only writes name one.
 */
export const instancesOfType = (adapters: readonly ServiceAdapter[], type: ServiceId): ServiceAdapter[] =>
    adapters.filter(a => a.type === type);

/**
 * The `instance` parameter's description, shared so every tool taking one words
 * it the same way. The model reads these, and three phrasings of one concept is
 * three chances to conclude they mean different things.
 */
export const INSTANCE_PARAM_DESCRIPTION =
    'Which instance, when several of this service are configured — for example "4k" or "hd". Omit it when there is only one. If several are configured and you omit it, the call is refused and the names are listed.';
