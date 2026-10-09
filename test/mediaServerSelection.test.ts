import { describe, expect, it } from 'vitest';
import { ConfigSchema, type Config } from '../src/config/schema.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { buildToolContext } from '../src/tools/register.ts';
import { pickMediaServer, bothIds } from '../src/tools/mediaServers.ts';
import { ServiceError } from '../src/core/errors.ts';
import type { MediaServerAdapter, ServiceAdapter } from '../src/services/types.ts';

const config = (): Config =>
    ConfigSchema.parse({
        auth: { bearer_token: 'a'.repeat(64), username: 'admin', allowed_hosts: [] },
        services: {}
    });

const mediaServer = (id: string, type: 'jellyfin' | 'plex' = 'jellyfin'): MediaServerAdapter =>
    ({
        id,
        type,
        testConnection: async () => ({ ok: true, service: id, latency_ms: 1 }),
        getVersion: async () => '1.0.0',
        listUsers: async () => [{ id: 'u1', name: 'Someone' }],
        listUserLibrary: async () => [],
        getPlayback: async () => [],
        getNextUp: async () => [],
        getWatchHistory: async () => []
    }) as unknown as MediaServerAdapter;

const bothConfig = (primary: 'jellyfin' | 'plex'): Config =>
    ConfigSchema.parse({
        auth: { bearer_token: 'a'.repeat(64), username: 'admin', allowed_hosts: [] },
        services: {
            jellyfin: { url: 'http://192.0.2.10:8096', api_key: 'k', default_user: 'Someone' },
            plex: { url: 'http://192.0.2.10:32400', api_key: 'k', default_user: 'Someone' }
        },
        primary_media_server: primary
    });

/** Has playback but none of the rest of the media server contract. */
const playbackOnly = (id: string): ServiceAdapter =>
    ({
        id,
        type: 'jellyfin',
        testConnection: async () => ({ ok: true, service: id, latency_ms: 1 }),
        getVersion: async () => '1.0.0',
        getPlayback: async () => [],
        getNextUp: async () => [],
        getWatchHistory: async () => []
    }) as unknown as ServiceAdapter;

describe('media server selection', () => {
    it.each(['jellyfin', 'plex'] as const)('takes %s as primary when the config says so', primary => {
        const adapters = [mediaServer('jellyfin'), mediaServer('plex', 'plex')] as ServiceAdapter[];
        const context = buildToolContext(adapters, bothConfig(primary), WriteAudit.ephemeral(), new ConfirmTokens());

        expect(context.mediaServers.primary?.adapter.id).toBe(primary);
        expect(context.mediaServers.secondary?.adapter.id).toBe(primary === 'jellyfin' ? 'plex' : 'jellyfin');
        expect(context.mediaServerIdentity).toBe(context.mediaServers.primary?.identity);
        expect(context.mediaServers.secondary?.identity).toBeDefined();
    });

    it('ignores adapter order when picking the primary', () => {
        const adapters = [mediaServer('plex', 'plex'), mediaServer('jellyfin')] as ServiceAdapter[];
        const context = buildToolContext(adapters, bothConfig('jellyfin'), WriteAudit.ephemeral(), new ConfirmTokens());
        expect(context.mediaServers.primary?.adapter.id).toBe('jellyfin');
    });

    it('throws on two media servers with no primary, which the schema should have caught', () => {
        const adapters = [mediaServer('jellyfin'), mediaServer('plex', 'plex')] as ServiceAdapter[];
        expect(() => buildToolContext(adapters, config(), WriteAudit.ephemeral(), new ConfirmTokens())).toThrow(/primary_media_server/);
    });

    it('has no secondary with one media server', () => {
        const context = buildToolContext([mediaServer('jellyfin')] as ServiceAdapter[], config(), WriteAudit.ephemeral(), new ConfirmTokens());
        expect(context.mediaServers.secondary).toBeUndefined();
    });

    it('builds a context with exactly one media server', () => {
        const adapters = [mediaServer('jellyfin')] as ServiceAdapter[];

        expect(() =>
            buildToolContext(adapters, config(), WriteAudit.ephemeral(), new ConfirmTokens())
        ).not.toThrow();
    });

    it('refuses a playback-only adapter, naming it and the missing capability', () => {
        const adapters = [playbackOnly('plexish')] as ServiceAdapter[];

        expect(() =>
            buildToolContext(adapters, config(), WriteAudit.ephemeral(), new ConfirmTokens())
        ).toThrow(/plexish.*listUsers/i);
    });

    it('refuses a library-only adapter (no playback), naming it and the missing capability', () => {
        const libraryOnly = {
            id: 'libraryish',
            type: 'jellyfin',
            testConnection: async () => ({ ok: true, service: 'libraryish', latency_ms: 1 }),
            getVersion: async () => '1.0.0',
            listUsers: async () => [{ id: 'u1', name: 'Someone' }],
            listUserLibrary: async () => []
            // deliberately no getPlayback/getNextUp/getWatchHistory
        } as unknown as ServiceAdapter;
        const adapters = [libraryOnly] as ServiceAdapter[];

        expect(() =>
            buildToolContext(adapters, config(), WriteAudit.ephemeral(), new ConfirmTokens())
        ).toThrow(/libraryish.*getPlayback/i);
    });

    it('builds a working identity resolver for a Plex-only config (Critical: was jellyfin-only)', async () => {
        const adapters = [mediaServer('plex', 'plex')] as ServiceAdapter[];
        const plexConfig = ConfigSchema.parse({
            auth: { bearer_token: 'a'.repeat(64), username: 'admin', allowed_hosts: [] },
            services: {
                plex: { url: 'http://192.0.2.10:32400', api_key: 'k', default_user: 'Someone' }
            }
        });

        const context = buildToolContext(adapters, plexConfig, WriteAudit.ephemeral(), new ConfirmTokens());

        expect(context.mediaServerIdentity).toBeDefined();
        const resolved = await context.mediaServerIdentity?.resolve();
        expect(resolved?.name).toBe('Someone');
    });
});

describe('pickMediaServer', () => {
    const j = { adapter: mediaServer('jellyfin'), identity: undefined };
    const p = { adapter: mediaServer('plex', 'plex'), identity: undefined };

    it('defaults to the primary', () => {
        expect(pickMediaServer({ primary: p, secondary: j }, undefined)).toBe(p);
    });
    it('picks the secondary by id', () => {
        expect(pickMediaServer({ primary: p, secondary: j }, 'jellyfin')).toBe(j);
    });
    it('refuses a server that is not configured, with a remedy', () => {
        const run = () => pickMediaServer({ primary: j }, 'plex');
        expect(run).toThrow(ServiceError);
        expect(run).toThrow(/plex/);
    });
    it('returns undefined with nothing configured and nothing asked', () => {
        expect(pickMediaServer({}, undefined)).toBeUndefined();
    });
    it('names both ids only when both are configured', () => {
        expect(bothIds({ primary: p, secondary: j })).toEqual(['plex', 'jellyfin']);
        expect(bothIds({ primary: j })).toBeUndefined();
    });
});
