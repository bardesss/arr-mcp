import * as z from 'zod/v4';
import { serviceOf, type ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import type { ServiceAdapter } from '../services/types.ts';
import { INSTANCE_PARAM_DESCRIPTION, instancesOfType, resolveInstance } from './resolveInstance.ts';

/**
 * The services a tool takes and what it needs of them, said once: the
 * `service` field advertises the list, and a refusal names the same list.
 */
export type ServiceTarget<A extends ServiceAdapter> = {
    readonly services: readonly ServiceId[];
    readonly can: (adapter: ServiceAdapter) => adapter is A;
    /** Follows the service's name in the refusal: `radarr cannot grab a release`. */
    readonly cannot: string;
    /** Follows the list of services that can. */
    readonly hint?: string;
};

export const serviceTarget = <A extends ServiceAdapter>(target: ServiceTarget<A>): ServiceTarget<A> => target;

const listed = (services: readonly ServiceId[]): string =>
    services.length < 2 ? services.join('') : `${services.slice(0, -1).join(', ')} and ${services.at(-1) ?? ''}`;

/** `service` and `instance`, for a write tool's input schema. `service` is narrowed to the target's list. */
export const targetInput = (target: ServiceTarget<ServiceAdapter>, describe?: string) => ({
    service: describe === undefined ? serviceOf(target.services) : serviceOf(target.services).describe(describe),
    instance: z.string().optional().describe(INSTANCE_PARAM_DESCRIPTION)
});

const refusal = (target: ServiceTarget<ServiceAdapter>, service: string): ServiceError =>
    new ServiceError('NotFound', service, `${service} ${target.cannot}`, {
        remedy: `This works with ${listed(target.services)} only.${target.hint === undefined ? '' : ` ${target.hint}`}`
    });

/** The one instance a write acts on: several and none named is a refusal. */
export function resolveTarget<A extends ServiceAdapter>(
    adapters: readonly ServiceAdapter[],
    target: ServiceTarget<A>,
    service: ServiceId,
    instance?: string
): A {
    const adapter = resolveInstance(adapters, service, instance);
    if (!target.can(adapter)) throw refusal(target, service);
    return adapter;
}

/**
 * The instances a read asks. No service is every instance that can answer; a
 * service with no instance named is every instance of it, since someone runs a
 * second Radarr so that their library is the union of both. A service that
 * cannot answer is refused rather than answered empty: an empty list reads as
 * "there is nothing", a different claim from "this service cannot say".
 */
export function readTargets<A extends ServiceAdapter>(
    adapters: readonly ServiceAdapter[],
    target: ServiceTarget<A>,
    service: ServiceId | undefined,
    instance?: string
): A[] {
    if (service === undefined) return adapters.filter(target.can);
    if (instance !== undefined && instance !== '') return [resolveTarget(adapters, target, service, instance)];
    const all = instancesOfType(adapters, service);
    if (all.length === 0) resolveInstance(adapters, service);
    const able = all.filter(target.can);
    if (able.length === 0) throw refusal(target, service);
    return able;
}
