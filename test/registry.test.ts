import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config/schema.ts';
import { buildAdapters } from '../src/services/registry.ts';

const AUTH = { bearer_token: 'a'.repeat(64), password_hash: 'scrypt$00$11' };
const keyed = (port: number) => ({ url: `http://h:${port}`, api_key: 'k' });

describe('buildAdapters', () => {
    it('builds nothing when no service is configured', () => {
        expect(buildAdapters(ConfigSchema.parse({ auth: AUTH, services: {} }))).toEqual([]);
    });

    it('builds only the services that are configured', () => {
        const config = ConfigSchema.parse({ auth: AUTH, services: { radarr: keyed(7878) } });
        expect(buildAdapters(config).map(a => a.id)).toEqual(['radarr']);
    });

    it('builds all nine in a stable, alphabetical order', () => {
        const config = ConfigSchema.parse({
            auth: AUTH,
            services: {
                radarr: keyed(7878),
                sonarr: keyed(8989),
                prowlarr: keyed(9696),
                bazarr: keyed(6767),
                sabnzbd: keyed(8080),
                jellyfin: keyed(8096),
                seerr: keyed(5055),
                transmission: { url: 'http://h:9091', username: 'u', password: 'p' },
                qbittorrent: { url: 'http://h:8081', username: 'u', password: 'p' }
            }
        });

        // Alphabetical, so stack_health output is stable across restarts.
        expect(buildAdapters(config).map(a => a.id)).toEqual([
            'bazarr',
            'jellyfin',
            'prowlarr',
            'qbittorrent',
            'radarr',
            'sabnzbd',
            'seerr',
            'sonarr',
            'transmission'
        ]);
    });

    // Two torrent clients is a real setup — one for public trackers and one for
    // private, or a migration with both running. Nothing here is exclusive.
    it('builds both torrent clients when both are configured', () => {
        const config = ConfigSchema.parse({
            auth: AUTH,
            services: {
                transmission: { url: 'http://h:9091' },
                qbittorrent: { url: 'http://h:8081', username: 'u', password: 'p' }
            }
        });
        expect(buildAdapters(config).map(a => a.id)).toEqual(['qbittorrent', 'transmission']);
    });

    it('builds transmission without credentials, which LAN RPC often has none of', () => {
        const config = ConfigSchema.parse({
            auth: AUTH,
            services: { transmission: { url: 'http://h:9091' } }
        });
        expect(buildAdapters(config).map(a => a.id)).toEqual(['transmission']);
    });
});
