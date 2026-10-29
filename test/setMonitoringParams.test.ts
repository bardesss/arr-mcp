import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';
import type { AnyServiceConfig, KeyedServiceConfig, ServiceId } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { ServiceError } from '../src/core/errors.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import { LidarrAdapter } from '../src/services/lidarr.ts';
import { SonarrAdapter } from '../src/services/sonarr.ts';
import { WhisparrAdapter } from '../src/services/whisparr.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import { registerSetMonitoring } from '../src/tools/setMonitoring.ts';
import { instancesOf } from './helpers/instances.ts';

/**
 * A bad argument and a missing item are different answers, and only one of them
 * is a `ServiceError`.
 *
 * `ServiceError` prefixes the service and its kind — "sonarr not found: `id` is
 * required" — so a missing parameter read as a library that does not hold the
 * item, and the caller went looking in the wrong place. The schema cannot carry
 * this alone: `id` and `monitored` are optional there because the Lidarr artist
 * level refuses them, so every service is checked at runtime instead, and these
 * tests are what holds that check in place.
 */

const configFor = (): KeyedServiceConfig => ({
    url: 'http://192.0.2.10:8989',
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: true, destructive: false }
});

/** Reaching the service at all would be the failure this file checks for. */
const neverCalled = (() => {
    throw new Error('a refused argument must not reach the service');
}) as unknown as typeof fetch;

type Call = (args: Record<string, unknown>) => Promise<{ structuredContent: Record<string, unknown> }>;

function harness(adapters: ServiceAdapter[], permissions: Partial<Record<ServiceId, AnyServiceConfig>>) {
    let call: Call = () => Promise.reject(new Error('not registered'));
    const server = {
        registerTool(_n: string, config: { inputSchema: z.ZodObject }, handler: Call) {
            call = args => handler(config.inputSchema.parse(args) as Record<string, unknown>);
        }
    };

    registerSetMonitoring(
        server as never,
        {
            permissions: permissionSourceFrom(instancesOf(permissions)),
            confirm: new ConfirmTokens(),
            audit: WriteAudit.ephemeral(),
            library: { invalidate: vi.fn() } as never
        } as never,
        adapters
    );

    return { call: (a: Record<string, unknown>) => call(a) };
}

const SERVICE_IDS: ServiceId[] = ['sonarr', 'whisparr', 'lidarr'];

const harnessFor = (service: ServiceId) => {
    const config = configFor();
    const permissions: Partial<Record<ServiceId, AnyServiceConfig>> = { [service]: config as AnyServiceConfig };
    const adapter: ServiceAdapter =
        service === 'sonarr'
            ? new SonarrAdapter(config as never, neverCalled)
            : service === 'whisparr'
              ? new WhisparrAdapter(config as never, neverCalled)
              : new LidarrAdapter(config as never, neverCalled);
    return harness([adapter], permissions);
};

/** The type a caller must be able to tell apart from a missing item. */
const isParameterError = (err: unknown): boolean => err instanceof Error && !(err instanceof ServiceError);

const caught = (run: Promise<unknown>) => run.catch((err: unknown) => err);

describe('set_monitoring argument checks', () => {
    for (const service of SERVICE_IDS) {
        const level = service === 'lidarr' ? { level: 'album' } : {};

        it(`refuses a missing id on ${service} without reaching the service`, async () => {
            const err = await caught(harnessFor(service).call({ service, ...level, monitored: false }));

            expect(isParameterError(err)).toBe(true);
            expect((err as Error).message).toContain('`id` is required');
        });

        it(`refuses a missing monitored on ${service} without reaching the service`, async () => {
            const err = await caught(harnessFor(service).call({ service, ...level, id: '7' }));

            expect(isParameterError(err)).toBe(true);
            expect((err as Error).message).toContain('`monitored` is required');
        });
    }

    it('refuses the artist level on a service that has no artist policy', async () => {
        const err = await caught(harnessFor('sonarr').call({ service: 'sonarr', level: 'artist', id: '7', monitored: false }));

        expect(isParameterError(err)).toBe(true);
        expect((err as Error).message).toContain('`level` is a lidarr parameter');
    });

    it('refuses any level on a service that keeps no levels', async () => {
        const err = await caught(harnessFor('sonarr').call({ service: 'sonarr', level: 'album', id: '7', monitored: false }));

        expect(isParameterError(err)).toBe(true);
        expect((err as Error).message).toContain('`level` is a lidarr parameter');
    });

    it('refuses artist-only parameters on the album level', async () => {
        const err = await caught(
            harnessFor('lidarr').call({ service: 'lidarr', level: 'album', id: '7', monitored: false, artists: ['1'] })
        );

        expect(isParameterError(err)).toBe(true);
        expect((err as Error).message).toContain('need `level: "artist"`');
    });

    it('refuses season and episodes together', async () => {
        const err = await caught(
            harnessFor('sonarr').call({ service: 'sonarr', id: '7', monitored: false, season: 1, episodes: ['1'] })
        );

        expect(isParameterError(err)).toBe(true);
    });

    /**
     * The other half of the pair: a real missing item keeps its `ServiceError`,
     * because that one is a fact about the service rather than about the call.
     */
    it('keeps ServiceError for an artist Lidarr does not hold', async () => {
        const config = configFor();
        const permissions: Partial<Record<ServiceId, AnyServiceConfig>> = { lidarr: config as AnyServiceConfig };
        const artists = [{ id: 1, artistName: 'Alex G', monitored: true, monitorNewItems: 'all' }];
        const fetchArtists = (async () =>
            new Response(JSON.stringify(artists), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            })) as unknown as typeof fetch;
        const h = harness([new LidarrAdapter(config as never, fetchArtists)], permissions);

        const err = await caught(h.call({ service: 'lidarr', level: 'artist', artists: ['99'], monitored: false }));

        expect(err).toBeInstanceOf(ServiceError);
        expect((err as ServiceError).kind).toBe('NotFound');
    });
});
