import { instanceId, type ServiceInstance } from '../../src/config/instances.ts';
import type { AnyServiceConfig, ServiceId } from '../../src/config/schema.ts';

/**
 * Instances from the plain `{ radarr: config }` maps these tests already build.
 *
 * `permissionSourceFrom` takes a flattened instance list now, because
 * permissions are granted per instance. Almost every write test wants a single
 * unnamed instance of one or two services, which is what a bare map describes —
 * so this keeps those tests saying what they mean instead of restating the
 * instance shape a dozen times.
 *
 * A config carrying a `name` becomes a named instance, so a test about naming
 * says so in the config it already writes rather than in a second helper. That
 * is behaviour-preserving for every caller that passes no name, which is what
 * `instanceId` does with an undefined one.
 *
 * This replaced two verbatim copies of a `instancesWithNames` helper (#201).
 * A map is still the shape here because a `Partial<Record<ServiceId, …>>` holds
 * one config per service type; tests needing *two* of the same type build the
 * instance list directly.
 */
export const instancesOf = (map: Partial<Record<ServiceId, AnyServiceConfig>>): ServiceInstance[] =>
    Object.entries(map).flatMap(([type, config]) => {
        if (config === undefined) return [];
        const name = (config as { name?: string }).name;
        return [
            {
                id: instanceId(type as ServiceId, name),
                type: type as ServiceId,
                ...(name === undefined ? {} : { name }),
                config
            } as ServiceInstance
        ];
    });

/** Two or more instances of the *same* service, which the map shape cannot
 *  express. Named, because that is the only way two of one type differ. */
export const namedInstances = (type: ServiceId, configs: readonly AnyServiceConfig[]): ServiceInstance[] =>
    configs.map(config => {
        const name = (config as { name?: string }).name;
        return {
            id: instanceId(type, name),
            type,
            ...(name === undefined ? {} : { name }),
            config
        } as ServiceInstance;
    });
