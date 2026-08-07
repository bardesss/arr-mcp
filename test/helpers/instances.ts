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
 * Named instances are built explicitly in the tests that are actually about
 * naming; this deliberately does not grow an options bag to cover them.
 */
export const instancesOf = (map: Partial<Record<ServiceId, AnyServiceConfig>>): ServiceInstance[] =>
    Object.entries(map).flatMap(([type, config]) =>
        config === undefined
            ? []
            : [{ id: instanceId(type as ServiceId), type: type as ServiceId, config }]
    );
