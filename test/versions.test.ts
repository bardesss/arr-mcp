import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ServiceId } from '../src/config/schema.ts';
import type { ServiceError } from '../src/core/errors.ts';
import { MINIMUM_VERSIONS, assertVersionSupported, compareVersions, parseVersion } from '../src/services/versions.ts';

const ROOT = join(import.meta.dirname, '..');
const read = (path: string): unknown => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));

const rejection = (fn: () => void): ServiceError => {
    try {
        fn();
        throw new Error('expected a throw');
    } catch (err) {
        return err as ServiceError;
    }
};

describe('parseVersion', () => {
    it('parses a plain dotted version', () => {
        expect(parseVersion('4.0.19')).toEqual([4, 0, 19]);
    });

    it('parses an *arr four-part version', () => {
        expect(parseVersion('6.3.0.10514')).toEqual([6, 3, 0, 10514]);
    });

    it('ignores a build suffix, which Transmission reports', () => {
        // A live Transmission returns "4.1.3 (838877323f)".
        expect(parseVersion('4.1.3 (838877323f)')).toEqual([4, 1, 3]);
    });

    it('ignores a leading v', () => {
        expect(parseVersion('v1.6.0')).toEqual([1, 6, 0]);
    });

    it('returns undefined for something that is not a version', () => {
        expect(parseVersion('unknown')).toBeUndefined();
        expect(parseVersion('')).toBeUndefined();
    });
});

describe('compareVersions', () => {
    it('orders by the first differing part', () => {
        expect(compareVersions([4, 1, 0], [4, 0, 9])).toBeGreaterThan(0);
        expect(compareVersions([3, 9, 9], [4, 0, 0])).toBeLessThan(0);
    });

    it('treats a missing trailing part as zero', () => {
        expect(compareVersions([4, 0], [4, 0, 0])).toBe(0);
        expect(compareVersions([4, 0, 1], [4, 0])).toBeGreaterThan(0);
    });

    it('compares numerically, not lexically', () => {
        // The bug a string compare would produce: "10" < "9".
        expect(compareVersions([1, 10], [1, 9])).toBeGreaterThan(0);
    });
});

describe('assertVersionSupported', () => {
    it('accepts a version above the floor', () => {
        expect(() => assertVersionSupported('radarr', '6.3.0.10514')).not.toThrow();
    });

    it('accepts a version exactly at the floor', () => {
        expect(() => assertVersionSupported('radarr', MINIMUM_VERSIONS.radarr)).not.toThrow();
    });

    it('rejects a version below the floor as VersionUnsupported', () => {
        const err = rejection(() => assertVersionSupported('radarr', '3.0.0.0'));
        expect(err.kind).toBe('VersionUnsupported');
        expect(err.service).toBe('radarr');
    });

    it('names both versions in the remedy, so the fix is obvious', () => {
        const err = rejection(() => assertVersionSupported('radarr', '3.0.0.0'));
        expect(err.remedy).toContain(MINIMUM_VERSIONS.radarr);
        expect(err.detail).toContain('3.0.0.0');
    });

    it('accepts an unparseable version rather than blocking on it', () => {
        // A service that reports something we cannot parse is not evidence of
        // an old version, and refusing to talk to it would be worse than the
        // uncertainty. The adapter's own reads will fail loudly if it is wrong.
        expect(() => assertVersionSupported('bazarr', 'nightly')).not.toThrow();
    });

    it('has a floor for every service', () => {
        const services = ['radarr', 'sonarr', 'prowlarr', 'bazarr', 'jellyfin', 'seerr', 'sabnzbd', 'transmission'];
        for (const s of services) expect(MINIMUM_VERSIONS[s as keyof typeof MINIMUM_VERSIONS]).toBeTruthy();
    });

    it('has a parseable floor for every service', () => {
        // The reported failure mode of an unparseable floor was wrong —
        // parseVersion("4..0") returns [4], not undefined. The genuine
        // silent-disable case is a digit-free floor: parseVersion("four")
        // returns undefined, assertVersionSupported's `minimum === undefined`
        // guard returns early, and enforcement is off for that service with a
        // green suite, since nothing else exercises MINIMUM_VERSIONS' values.
        for (const [service, floor] of Object.entries(MINIMUM_VERSIONS)) {
            expect(parseVersion(floor), `${service}'s floor "${floor}" must parse`).toBeDefined();
        }
    });
});

describe('assertVersionSupported against captured evidence', () => {
    // Every fixture below was captured from the real reference stack this
    // project was developed against (see the version list in versions.ts's
    // header comment). Checking each floor against that real version, rather
    // than a hand-written string, is the "no capability without a fixture"
    // discipline this project is held to elsewhere applied to the floors
    // themselves — it is the test that would actually catch a floor
    // accidentally set above what a real, currently-supported install
    // reports.
    const captured: Record<ServiceId, string> = {
        radarr: (read('test/fixtures/radarr/system-status.json') as { version: string }).version,
        sonarr: (read('test/fixtures/sonarr/system-status.json') as { version: string }).version,
        prowlarr: (read('test/fixtures/prowlarr/system-status.json') as { version: string }).version,
        bazarr: (read('test/fixtures/bazarr/system-status.json') as { data: { bazarr_version: string } }).data.bazarr_version,
        jellyfin: (read('test/fixtures/jellyfin/system-info.json') as { Version: string }).Version,
        seerr: (read('test/fixtures/seerr/status.json') as { version: string }).version,
        sabnzbd: (read('test/fixtures/sabnzbd/version.json') as { version: string }).version,
        transmission: (read('test/fixtures/transmission/session-get.json') as { arguments: { version: string } }).arguments.version
    };

    for (const [service, version] of Object.entries(captured)) {
        it(`accepts ${service}'s captured version (${version})`, () => {
            expect(() => assertVersionSupported(service as ServiceId, version)).not.toThrow();
        });
    }
});
