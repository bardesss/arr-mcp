import { describe, expect, it } from 'vitest';
import { instanceId, isMultiInstance, listInstances } from '../src/config/instances.ts';
import { ConfigSchema, MULTI_INSTANCE, type Config } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { checkPermission, permissionSourceFrom } from '../src/core/permissions.ts';
import { buildAdapters } from '../src/services/registry.ts';

/**
 * Multiple instances of one service — an HD and a 4K Radarr, and the Bazarr
 * per stack that follows from them.
 *
 * The single form staying valid is the load-bearing property here. It is what
 * makes this a widening rather than a migration, so it is asserted first and
 * asserted often.
 */

const AUTH = { bearer_token: 'a'.repeat(64), username: 'admin', allowed_hosts: [] };

const parse = (services: unknown): Config => ConfigSchema.parse({ auth: AUTH, services });

const entry = (name: string | undefined, port: number, perms = {}) => ({
    ...(name === undefined ? {} : { name }),
    url: `http://192.0.2.10:${port}`,
    api_key: 'k',
    permissions: perms
});

describe('the single form is untouched', () => {
    it('parses exactly as it did, and yields one instance with a bare id', () => {
        const config = parse({ radarr: entry(undefined, 7878) });
        const instances = listInstances(config);

        expect(instances).toHaveLength(1);
        expect(instances[0]?.id).toBe('radarr');
        expect(instances[0]?.type).toBe('radarr');
        expect(instances[0]?.name).toBeUndefined();
    });

    // Existing audit rows, log filters and error messages all say `radarr`.
    // The bare id surviving is what spares them a backfill.
    it('keeps the bare id, which is what makes this a widening', () => {
        expect(instanceId('radarr')).toBe('radarr');
        expect(instanceId('radarr', '4k')).toBe('radarr/4k');
    });
});

describe('the list form', () => {
    it('parses under each service that may repeat', () => {
        for (const type of MULTI_INSTANCE) {
            const config = parse({ [type]: [entry('hd', 7878), entry('4k', 7879)] });
            expect(listInstances(config).map(i => i.id)).toEqual([`${type}/4k`, `${type}/hd`]);
        }
    });

    it('orders instances by id, so output is stable across restarts', () => {
        const config = parse({
            sonarr: entry(undefined, 8989),
            radarr: [entry('hd', 7878), entry('4k', 7879)]
        });
        expect(listInstances(config).map(i => i.id)).toEqual(['radarr/4k', 'radarr/hd', 'sonarr']);
    });

    it('scopes names per service, so 4k under two services is not a clash', () => {
        const config = parse({
            radarr: [entry('4k', 7879)],
            sonarr: [entry('4k', 8990)]
        });
        expect(listInstances(config).map(i => i.id)).toEqual(['radarr/4k', 'sonarr/4k']);
    });

    it('accepts a single-element list, which is a named sole instance', () => {
        const config = parse({ radarr: [entry('main', 7878)] });
        expect(listInstances(config)[0]?.id).toBe('radarr/main');
    });
});

describe('what the list form refuses', () => {
    it('refuses an entry with no name — an unnamed instance cannot be addressed', () => {
        expect(() => parse({ radarr: [entry(undefined, 7878), entry('4k', 7879)] })).toThrow();
    });

    it('refuses duplicate names, case-insensitively', () => {
        expect(() => parse({ radarr: [entry('4k', 7878), entry('4K', 7879)] })).toThrow(/duplicate instance name/i);
    });

    it('refuses an empty list', () => {
        expect(() => parse({ radarr: [] })).toThrow();
    });

    // A name reaches the qualified id, and a `/` there would make the id
    // ambiguous about where the service ends and the instance begins.
    it('refuses a name containing a slash or a space', () => {
        expect(() => parse({ radarr: [entry('4k/uhd', 7878)] })).toThrow();
        expect(() => parse({ radarr: [entry('four k', 7878)] })).toThrow();
    });

    /**
     * The boundary is the design, so it is tested rather than commented.
     *
     * `register.ts` selects Prowlarr, Jellyfin and Seerr with a `.find`, and the
     * identity resolver is built from *the* Jellyfin config. Admitting a list
     * there would produce configurations the code silently degrades on.
     */
    it('refuses a list under a service that may not repeat, and names the ones that may', () => {
        for (const type of ['prowlarr', 'sabnzbd', 'jellyfin', 'seerr', 'transmission']) {
            expect(isMultiInstance(type as never)).toBe(false);
            expect(() => parse({ [type]: [entry('a', 9999)] })).toThrow(/only bazarr, radarr, sonarr/i);
        }
    });
});

describe('adapters', () => {
    it('builds one adapter per instance, each with a distinct id and a shared type', () => {
        const config = parse({ radarr: [entry('hd', 7878), entry('4k', 7879)] });
        const adapters = buildAdapters(config);

        expect(adapters.map(a => a.id)).toEqual(['radarr/4k', 'radarr/hd']);
        expect(adapters.every(a => a.type === 'radarr')).toBe(true);
        expect(adapters.map(a => a.instance)).toEqual(['4k', 'hd']);
    });

    it('leaves a single instance reporting the bare id and no instance name', () => {
        const [adapter] = buildAdapters(parse({ radarr: entry(undefined, 7878) }));

        expect(adapter?.id).toBe('radarr');
        expect(adapter?.type).toBe('radarr');
        expect(adapter?.instance).toBeUndefined();
    });
});

describe('permissions are per instance', () => {
    /**
     * The point of keying on instance id rather than service type: safe writes
     * on the HD Radarr and nothing on the 4K one is a policy people actually
     * want, and the old shape could not express it.
     */
    it('grants a tier on one instance without granting it on its sibling', () => {
        const config = parse({
            radarr: [entry('hd', 7878, { safe_write: true }), entry('4k', 7879, { safe_write: false })]
        });
        const source = permissionSourceFrom(listInstances(config));

        expect(checkPermission(source, 'radarr/hd', 'safe').allowed).toBe(true);
        expect(checkPermission(source, 'radarr/4k', 'safe').allowed).toBe(false);
    });

    it('treats the bare type as unconfigured when every instance is named', () => {
        const config = parse({ radarr: [entry('hd', 7878, { safe_write: true })] });
        const verdict = checkPermission(permissionSourceFrom(listInstances(config)), 'radarr', 'safe');

        expect(verdict.allowed).toBe(false);
        expect(verdict.allowed === false && verdict.reason).toMatch(/not configured/);
    });

    it('still answers for a single unnamed instance, which is every config today', () => {
        const config = parse({ radarr: entry(undefined, 7878, { safe_write: true }) });
        expect(checkPermission(permissionSourceFrom(listInstances(config)), 'radarr', 'safe').allowed).toBe(true);
    });
});

describe('the audit trail', () => {
    it('round-trips a qualified instance id, so two Radarrs are distinguishable', () => {
        const audit = WriteAudit.ephemeral();
        try {
            const id = audit.begin({
                tool: 'add_media',
                service: 'radarr/4k',
                operation: 'add',
                tier: 'safe',
                target: '550',
                args: {}
            });
            audit.settle(id, 'applied');

            const [row] = audit.recent(1) as { service: string; outcome: string }[];
            expect(row?.service).toBe('radarr/4k');
            expect(row?.outcome).toBe('applied');
        } finally {
            audit.close();
        }
    });
});
