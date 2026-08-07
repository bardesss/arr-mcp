import { instancesOf } from './helpers/instances.ts';
import { describe, expect, it } from 'vitest';
import type { AnyServiceConfig, ServiceId } from '../src/config/schema.ts';
import { ServiceError } from '../src/core/errors.ts';
import { assertPermitted, checkPermission, permissionSourceFrom } from '../src/core/permissions.ts';

const service = (safe_write: boolean, destructive: boolean): AnyServiceConfig =>
    ({
        url: 'http://192.0.2.10:7878',
        api_key: 'k',
        timeout_ms: 10_000,
        permissions: { safe_write, destructive }
    }) as AnyServiceConfig;

const sourceFor = (permissions: Partial<Record<ServiceId, AnyServiceConfig>>) => permissionSourceFrom(instancesOf(permissions));

describe('permission tiers', () => {
    it('refuses both tiers by default — nothing but a deliberate edit grants a write', () => {
        const source = sourceFor({ radarr: service(false, false) });
        expect(checkPermission(source, 'radarr', 'safe').allowed).toBe(false);
        expect(checkPermission(source, 'radarr', 'destructive').allowed).toBe(false);
    });

    it('grants safe writes from safe_write', () => {
        const source = sourceFor({ radarr: service(true, false) });
        expect(checkPermission(source, 'radarr', 'safe').allowed).toBe(true);
    });

    it('does not let safe_write grant a destructive write', () => {
        const source = sourceFor({ radarr: service(true, false) });
        const verdict = checkPermission(source, 'radarr', 'destructive');
        expect(verdict.allowed).toBe(false);
    });

    // The ordering rule. A config that permits deleting a film but refuses to
    // re-monitor it describes no policy anyone would choose on purpose.
    it('lets destructive grant safe writes too, because the tiers are ordered', () => {
        const source = sourceFor({ radarr: service(false, true) });
        expect(checkPermission(source, 'radarr', 'safe').allowed).toBe(true);
        expect(checkPermission(source, 'radarr', 'destructive').allowed).toBe(true);
    });

    it('is per service — enabling Radarr does not enable Sonarr', () => {
        const source = sourceFor({ radarr: service(true, true), sonarr: service(false, false) });
        expect(checkPermission(source, 'radarr', 'safe').allowed).toBe(true);
        expect(checkPermission(source, 'sonarr', 'safe').allowed).toBe(false);
    });

    it('refuses an unconfigured service, naming the block to add', () => {
        const verdict = checkPermission(sourceFor({}), 'sonarr', 'safe');
        expect(verdict.allowed).toBe(false);
        if (verdict.allowed) return;
        expect(verdict.reason).toContain('not configured');
        expect(verdict.remedy).toContain('services.sonarr');
    });

    it('names the exact YAML key a denial needs, per tier', () => {
        const source = sourceFor({ radarr: service(false, false) });
        const safe = checkPermission(source, 'radarr', 'safe');
        const destructive = checkPermission(source, 'radarr', 'destructive');

        if (safe.allowed || destructive.allowed) throw new Error('expected both to be denied');
        expect(safe.remedy).toContain('services.radarr.permissions.safe_write: true');
        expect(destructive.remedy).toContain('services.radarr.permissions.destructive: true');
    });
});

describe('assertPermitted', () => {
    it('passes silently when granted', () => {
        expect(() => assertPermitted(sourceFor({ radarr: service(true, false) }), 'radarr', 'safe')).not.toThrow();
    });

    // §15: the remedy has to live in `.message`, because a generic catcher —
    // including the MCP SDK's own dispatch loop — reads nothing else.
    it('throws a ServiceError whose message already carries the remedy', () => {
        try {
            assertPermitted(sourceFor({ radarr: service(false, false) }), 'radarr', 'destructive');
            throw new Error('expected a throw');
        } catch (err) {
            expect(err).toBeInstanceOf(ServiceError);
            const se = err as ServiceError;
            expect(se.kind).toBe('PermissionDenied');
            expect(se.service).toBe('radarr');
            expect(se.message).toContain('permissions.destructive: true');
        }
    });
});
