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
import { fenceText } from '../src/core/fence.ts';
import { LibraryLoader } from '../src/tools/library.ts';
import { registerSetMonitoring } from '../src/tools/setMonitoring.ts';
import { instancesOf } from './helpers/instances.ts';

/**
 * A bad argument and a missing item are different answers, and only one of them
 * is a `ServiceError`.
 *
 * `ServiceError` prefixes the service and its kind — "sonarr not found: `id` is
 * required" — so a missing parameter read as a library that does not hold the
 * item, and the caller went looking in the wrong place. The schema cannot carry
 * this alone: `id` is optional there because `title` can stand in for it, so
 * every service is checked at runtime instead, and these tests are what holds
 * that check in place.
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

function harness(adapters: ServiceAdapter[], permissions: Partial<Record<ServiceId, AnyServiceConfig>>, loader?: LibraryLoader) {
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
        adapters,
        loader
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

        it(`refuses a missing monitored on ${service} at the schema, without reaching the service`, () => {
            expect(() => harnessFor(service).call({ service, ...level, id: '7' })).toThrow(/monitored/);
        });
    }

    it("refuses the artist level on every service: an artist's flag is update_media", () => {
        for (const service of SERVICE_IDS) {
            expect(() => harnessFor(service).call({ service, level: 'artist', id: '7', monitored: false })).toThrow(/Invalid input: expected \\"album\\"/);
        }
    });

    it('refuses any level on a service that keeps no levels', async () => {
        const err = await caught(harnessFor('sonarr').call({ service: 'sonarr', level: 'album', id: '7', monitored: false }));

        expect(isParameterError(err)).toBe(true);
        expect((err as Error).message).toContain('`level` is a lidarr parameter');
    });

    it('refuses the old artist-only parameters as unknown', () => {
        for (const extra of [{ artists: ['1'] }, { monitor_new_items: 'all' }]) {
            expect(() => harnessFor('lidarr').call({ service: 'lidarr', level: 'album', id: '7', monitored: false, ...extra })).toThrow(
                /Unknown argument\(s\)/
            );
        }
    });

    it('refuses season and episodes together', async () => {
        const err = await caught(
            harnessFor('sonarr').call({ service: 'sonarr', id: '7', monitored: false, season: 1, episodes: ['1'] })
        );

        expect(isParameterError(err)).toBe(true);
    });
});

describe('set_monitoring by title', () => {
    const library = new LibraryLoader(
        [
            {
                id: 'sonarr',
                testConnection: async () => ({ ok: true, service: 'sonarr', latency_ms: 1 }),
                getVersion: async () => '4.0.0',
                listLibrary: async () => [
                    {
                        kind: 'series',
                        title: fenceText('Rick and Morty', { service: 'sonarr', field: 'title' }),
                        year: 2013,
                        ids: { tvdb: 275274 },
                        acquisition: { service: 'sonarr', id: '15', monitored: true, hasFile: true }
                    }
                ]
            } as unknown as ServiceAdapter
        ],
        undefined
    );

    const withTitle = () => {
        const asked: string[] = [];
        const recording = (async (input: string | URL | Request) => {
            asked.push(new URL(input instanceof Request ? input.url : String(input)).pathname);
            return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
        }) as unknown as typeof fetch;
        const config = configFor();
        const h = harness([new SonarrAdapter(config as never, recording)], { sonarr: config as AnyServiceConfig }, library);
        return { ...h, asked };
    };

    it('reads the series the title resolves to', async () => {
        const h = withTitle();
        await h.call({ service: 'sonarr', title: 'Rick and Morty', season: 1, monitored: false }).catch(() => undefined);
        expect(h.asked).toContain('/api/v3/series/15');
    });

    it('refuses a title together with an id', async () => {
        const h = withTitle();
        await expect(h.call({ service: 'sonarr', title: 'Rick and Morty', id: '15', monitored: false })).rejects.toThrow(/either `id` or `title`/);
        expect(h.asked).toEqual([]);
    });

    it('refuses a title on lidarr', async () => {
        const h = harnessFor('lidarr');
        await expect(h.call({ service: 'lidarr', title: 'Rick and Morty', level: 'album', monitored: false })).rejects.toThrow(/`title` names a series/);
    });
});
