import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config/schema.ts';
import { buildAdapters } from '../src/services/registry.ts';
import { SabnzbdAdapter } from '../src/services/sabnzbd.ts';

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

describe('multi-instance download clients and Prowlarr', () => {
    const keyed = (name: string | undefined, port: number) => ({
        ...(name === undefined ? {} : { name }),
        url: `http://192.0.2.10:${port}`,
        api_key: 'k',
        permissions: {}
    });

    const credential = (name: string, port: number) => ({
        name,
        url: `http://192.0.2.10:${port}`,
        permissions: {}
    });

    const build = (services: unknown) =>
        buildAdapters(ConfigSchema.parse({ auth: AUTH, services }));

    it('gives two SABnzbds distinct ids and names', () => {
        const adapters = build({ sabnzbd: [keyed('main', 8080), keyed('spare', 8081)] });
        expect(adapters.map(a => a.id)).toEqual(['sabnzbd/main', 'sabnzbd/spare']);
        expect(adapters.map(a => a.instance)).toEqual(['main', 'spare']);
        // Capability dispatch keys on this, so both must still say what they are.
        expect(adapters.every(a => a.type === 'sabnzbd')).toBe(true);
    });

    it('gives two Prowlarrs distinct ids', () => {
        expect(build({ prowlarr: [keyed('public', 9696), keyed('private', 9697)] }).map(a => a.id)).toEqual([
            'prowlarr/private',
            'prowlarr/public'
        ]);
    });

    it('gives the credential clients distinct ids', () => {
        expect(build({ qbittorrent: [credential('vpn', 8081), credential('direct', 8082)] }).map(a => a.id)).toEqual([
            'qbittorrent/direct',
            'qbittorrent/vpn'
        ]);
        expect(build({ transmission: [credential('vpn', 9091), credential('direct', 9092)] }).map(a => a.id)).toEqual([
            'transmission/direct',
            'transmission/vpn'
        ]);
    });

    it('keeps the bare id for a single block', () => {
        expect(build({ sabnzbd: keyed(undefined, 8080) })[0]?.id).toBe('sabnzbd');
        expect(build({ sabnzbd: keyed(undefined, 8080) })[0]?.instance).toBeUndefined();
    });

    // ServiceHttp's first argument is what reaches error messages and log rows.
    // Left as the literal, two clients produce failures nothing can tell apart.
    it('carries the qualified id into the errors the transport raises', async () => {
        const refuse = (async () => {
            throw new Error('connection refused');
        }) as unknown as typeof fetch;

        const adapter = new SabnzbdAdapter({ ...keyed('spare', 8081), timeout_ms: 10_000 } as never, refuse);
        await expect(adapter.getVersion()).rejects.toMatchObject({ service: 'sabnzbd/spare' });
    });
});
