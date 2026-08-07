import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config/schema.ts';
import { ServiceError } from '../src/core/errors.ts';
import { buildAdapters } from '../src/services/registry.ts';
import { instancesOfType, resolveInstance } from '../src/tools/resolveInstance.ts';

/**
 * Which instance a call means, and — more importantly — when it refuses to
 * guess.
 *
 * Every refusal here is asserted to *name the alternatives*. A refusal that does
 * not say what to pass instead is a dead end: the model has no way to recover
 * except by guessing a second time.
 */

const AUTH = { bearer_token: 'a'.repeat(64), username: 'admin', allowed_hosts: [] };

const adaptersFor = (services: unknown) => buildAdapters(ConfigSchema.parse({ auth: AUTH, services }));

const one = { url: 'http://192.0.2.10:7878', api_key: 'k' };
const named = (name: string, port: number) => ({ name, url: `http://192.0.2.10:${port}`, api_key: 'k' });

const twoRadarrs = () => adaptersFor({ radarr: [named('hd', 7878), named('4k', 7879)] });

describe('resolving an instance', () => {
    it('uses the only instance when none is named — every config that exists today', () => {
        const adapters = adaptersFor({ radarr: one });
        expect(resolveInstance(adapters, 'radarr').id).toBe('radarr');
    });

    it('uses a named sole instance without being asked for the name', () => {
        const adapters = adaptersFor({ radarr: [named('main', 7878)] });
        expect(resolveInstance(adapters, 'radarr').id).toBe('radarr/main');
    });

    it('picks the named one out of several', () => {
        expect(resolveInstance(twoRadarrs(), 'radarr', '4k').id).toBe('radarr/4k');
        expect(resolveInstance(twoRadarrs(), 'radarr', 'hd').id).toBe('radarr/hd');
    });

    it('matches the name case-insensitively, because 4K and 4k are never two things', () => {
        expect(resolveInstance(twoRadarrs(), 'radarr', '4K').id).toBe('radarr/4k');
    });

    it('keys on the service type, not the id — the lookup that broke with two Radarrs', () => {
        // `adapters.find(a => a.id === 'radarr')` matches neither `radarr/hd`
        // nor `radarr/4k`. This is the regression that PR 1 created and this
        // resolver exists to close.
        expect(twoRadarrs().some(a => a.id === 'radarr')).toBe(false);
        expect(resolveInstance(twoRadarrs(), 'radarr', 'hd').type).toBe('radarr');
    });
});

describe('refusing to guess', () => {
    /**
     * The decision this whole design turns on. It is already house style: an
     * ambiguous quality profile match once sent a film to 1080p against an
     * explicit 2160p request, discovered only when the download finished.
     * Choosing between two Radarrs is that failure with a worse blast radius.
     */
    it('refuses when several are configured and none was named, and lists them', () => {
        try {
            resolveInstance(twoRadarrs(), 'radarr');
            expect.unreachable('should have refused');
        } catch (err) {
            expect(err).toBeInstanceOf(ServiceError);
            const message = (err as ServiceError).message;
            expect(message).toMatch(/2 instances/);
            expect(message).toContain('"4k"');
            expect(message).toContain('"hd"');
        }
    });

    it('refuses a name that is not configured, and lists the ones that are', () => {
        try {
            resolveInstance(twoRadarrs(), 'radarr', 'uhd');
            expect.unreachable('should have refused');
        } catch (err) {
            const message = (err as ServiceError).message;
            expect(message).toMatch(/no instance named "uhd"/);
            expect(message).toContain('"4k"');
            expect(message).toContain('"hd"');
        }
    });

    it('refuses a service with no instances at all, and says how to add one', () => {
        try {
            resolveInstance(adaptersFor({ radarr: one }), 'sonarr');
            expect.unreachable('should have refused');
        } catch (err) {
            const message = (err as ServiceError).message;
            expect(message).toMatch(/sonarr is not configured/);
            expect(message).toMatch(/services\.sonarr/);
        }
    });

    it('does not treat an empty string as a name', () => {
        expect(resolveInstance(adaptersFor({ radarr: one }), 'radarr', '').id).toBe('radarr');
    });
});

describe('reads span every instance', () => {
    it('returns all instances of a type, so a read can merge them', () => {
        expect(instancesOfType(twoRadarrs(), 'radarr').map(a => a.id)).toEqual(['radarr/4k', 'radarr/hd']);
    });

    it('returns nothing rather than throwing when the service is absent', () => {
        expect(instancesOfType(adaptersFor({ radarr: one }), 'bazarr')).toEqual([]);
    });
});
