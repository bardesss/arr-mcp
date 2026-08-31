import { describe, expect, it } from 'vitest';
import { ConfigSchema, type Config } from '../src/config/schema.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { buildToolContext } from '../src/tools/register.ts';
import type { MediaServerAdapter, ServiceAdapter } from '../src/services/types.ts';

const config = (): Config =>
    ConfigSchema.parse({
        auth: { bearer_token: 'a'.repeat(64), username: 'admin', allowed_hosts: [] },
        services: {}
    });

const mediaServer = (id: string): MediaServerAdapter =>
    ({
        id,
        type: 'jellyfin',
        testConnection: async () => ({ ok: true, service: id, latency_ms: 1 }),
        getVersion: async () => '1.0.0',
        listUsers: async () => [{ id: 'u1', name: 'Someone' }],
        listUserLibrary: async () => [],
        getPlayback: async () => [],
        getNextUp: async () => [],
        getWatchHistory: async () => []
    }) as unknown as MediaServerAdapter;

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
    it('refuses to build a context with two media servers', () => {
        const adapters = [mediaServer('jellyfin'), mediaServer('plexish')] as ServiceAdapter[];

        expect(() =>
            buildToolContext(adapters, config(), WriteAudit.ephemeral(), new ConfirmTokens())
        ).toThrow(/only one media server/i);
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
});
