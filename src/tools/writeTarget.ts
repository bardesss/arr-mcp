import * as z from 'zod/v4';
import { serviceOf, type ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import type { ServiceAdapter } from '../services/types.ts';
import { INSTANCE_PARAM_DESCRIPTION, resolveInstance } from './resolveInstance.ts';

/**
 * The services a write takes and what it needs of them, said once: the
 * `service` field advertises the list, and a refusal names the same list.
 */
export type WriteTarget<A extends ServiceAdapter> = {
    readonly services: readonly ServiceId[];
    readonly can: (adapter: ServiceAdapter) => adapter is A;
    /** Follows the service's name in the refusal: `radarr cannot grab a release`. */
    readonly cannot: string;
    /** Follows the list of services that can. */
    readonly hint?: string;
};

export const writeTarget = <A extends ServiceAdapter>(target: WriteTarget<A>): WriteTarget<A> => target;

const listed = (services: readonly ServiceId[]): string =>
    services.length < 2 ? services.join('') : `${services.slice(0, -1).join(', ')} and ${services.at(-1) ?? ''}`;

/** `service` and `instance`, for a write tool's input schema. `service` is narrowed to the target's list. */
export const targetInput = (target: WriteTarget<ServiceAdapter>, describe?: string) => ({
    service: describe === undefined ? serviceOf(target.services) : serviceOf(target.services).describe(describe),
    instance: z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION)
});

export function resolveTarget<A extends ServiceAdapter>(
    adapters: readonly ServiceAdapter[],
    target: WriteTarget<A>,
    service: ServiceId,
    instance?: string
): A {
    const adapter = resolveInstance(adapters, service, instance);
    if (!target.can(adapter)) {
        throw new ServiceError('NotFound', service, `${service} ${target.cannot}`, {
            remedy: `This works with ${listed(target.services)} only.${target.hint === undefined ? '' : ` ${target.hint}`}`
        });
    }
    return adapter;
}
