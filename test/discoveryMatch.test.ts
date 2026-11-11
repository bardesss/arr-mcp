import { describe, expect, it } from 'vitest';
import { ConfigSchema, type Config } from '../src/config/schema.ts';
import { matchResults, urlResolver } from '../src/discovery/match.ts';
import type { Found } from '../src/discovery/probe.ts';

const AUTH = { bearer_token: 'a'.repeat(64), username: 'admin', allowed_hosts: [] };
const parse = (services: unknown): Config => ConfigSchema.parse({ auth: AUTH, services });
const block = (url: string) => ({ url, api_key: 'k', permissions: {} });

// A stand-in for DNS: names map to addresses, everything else is left alone.
const NAMES: Record<string, string> = { 'http://radarr:7878': 'http://172.18.0.5:7878' };
const resolve = async (url: string): Promise<string> => NAMES[url] ?? url;

describe('matchResults', () => {
    it('marks a find as added when it is the configured url, after resolving names', async () => {
        const config = parse({ radarr: block('http://radarr:7878') });
        const found: Found[] = [{ type: 'radarr', url: 'http://172.18.0.5:7878', source: 'sweep' }];
        const rows = await matchResults(found, config, resolve);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.status).toBe('added');
    });

    it('marks a single-instance type configured elsewhere as configured, with its url', async () => {
        const config = parse({ seerr: block('http://192.168.1.9:5055') });
        const found: Found[] = [{ type: 'seerr', url: 'http://192.168.1.20:5055', source: 'sweep' }];
        const rows = await matchResults(found, config, resolve);
        expect(rows[0]).toMatchObject({ status: 'configured', existingUrl: 'http://192.168.1.9:5055' });
    });

    it('marks a multi-instance type configured elsewhere as maybe-second', async () => {
        const config = parse({ radarr: block('http://192.168.1.9:7878') });
        const found: Found[] = [{ type: 'radarr', url: 'http://192.168.1.20:7878', source: 'sweep' }];
        const rows = await matchResults(found, config, resolve);
        expect(rows[0]).toMatchObject({ status: 'maybe-second', existingUrl: 'http://192.168.1.9:7878' });
    });

    it('marks a type that is not configured as new', async () => {
        const rows = await matchResults([{ type: 'radarr', url: 'http://192.168.1.20:7878', source: 'sweep' }], parse({}), resolve);
        expect(rows[0]?.status).toBe('new');
        expect(rows[0]?.existingUrl).toBeUndefined();
    });

    it('merges the same type and version seen by host and by container', async () => {
        const found: Found[] = [
            { type: 'radarr', url: 'http://radarr:7878', version: '5.0', source: 'container' },
            { type: 'radarr', url: 'http://nas.lan:7878', version: '5.0', source: 'host' }
        ];
        const rows = await matchResults(found, parse({}), resolve);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ url: 'http://nas.lan:7878', alsoAt: 'http://radarr:7878' });
    });

    it('keeps two rows when the versions differ', async () => {
        const found: Found[] = [
            { type: 'radarr', url: 'http://nas.lan:7878', version: '5.0', source: 'host' },
            { type: 'radarr', url: 'http://radarr:7878', version: '4.0', source: 'container' }
        ];
        expect(await matchResults(found, parse({}), resolve)).toHaveLength(2);
    });

    it('keeps two rows when neither side reports a version', async () => {
        const found: Found[] = [
            { type: 'radarr', url: 'http://nas.lan:7878', source: 'host' },
            { type: 'radarr', url: 'http://radarr:7878', source: 'container' }
        ];
        expect(await matchResults(found, parse({}), resolve)).toHaveLength(2);
    });

    it('merges without versions when both urls resolve to one address', async () => {
        const oneAddress = async (url: string) => (url.endsWith(':7878') ? 'http://172.18.0.5:7878' : url);
        const found: Found[] = [
            { type: 'radarr', url: 'http://nas.lan:7878', source: 'host' },
            { type: 'radarr', url: 'http://radarr:7878', source: 'container' }
        ];
        const rows = await matchResults(found, parse({}), oneAddress);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ url: 'http://nas.lan:7878', alsoAt: 'http://radarr:7878' });
    });

    it('lists a sweep hit on the address a host or container find resolves to once, under the named url', async () => {
        const lan = async (url: string) => (url === 'http://nas.lan:7878' ? 'http://192.168.1.10:7878' : resolve(url));
        const found: Found[] = [
            { type: 'radarr', url: 'http://nas.lan:7878', source: 'host' },
            { type: 'radarr', url: 'http://radarr:7878', source: 'container' },
            { type: 'radarr', url: 'http://192.168.1.10:7878', source: 'sweep' },
            { type: 'radarr', url: 'http://172.18.0.5:7878', source: 'sweep' }
        ];
        const rows = await matchResults(found, parse({}), lan);
        expect(rows.map(r => r.url)).toEqual(['http://nas.lan:7878', 'http://radarr:7878']);
    });

    it('lets a host find take over a sweep row on the same address, whatever the order', async () => {
        const lan = async (url: string) => (url === 'http://nas.lan:7878' ? 'http://192.168.1.10:7878' : url);
        const found: Found[] = [
            { type: 'radarr', url: 'http://192.168.1.10:7878', source: 'sweep' },
            { type: 'radarr', url: 'http://nas.lan:7878', source: 'host' }
        ];
        const rows = await matchResults(found, parse({}), lan);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ url: 'http://nas.lan:7878', source: 'host' });
    });

    it.each([
        ['IPv6-first', ['fd00::5', '192.168.1.10']],
        ['public-first', ['203.0.113.7', '192.168.1.10']]
    ])('matches a sweep hit to a host that resolves %s, on the address the probe would use', async (_order, answers) => {
        const resolver = urlResolver(async host => (host === 'nas.lan' ? answers : []));
        const found: Found[] = [
            { type: 'radarr', url: 'http://nas.lan:7878', source: 'host' },
            { type: 'radarr', url: 'http://192.168.1.10:7878', source: 'sweep' }
        ];
        const rows = await matchResults(found, parse({}), resolver);
        expect(rows.map(r => r.url)).toEqual(['http://nas.lan:7878']);
    });

    it('matches on the address the probe connected to, and keeps that address out of the row', async () => {
        // The resolver would place nas.lan elsewhere; the probe said where it went.
        const elsewhere = async (url: string) => (url === 'http://nas.lan:7878' ? 'http://[fd00::5]:7878' : url);
        const found: Found[] = [
            { type: 'radarr', url: 'http://nas.lan:7878', source: 'host', address: '192.168.1.10' },
            { type: 'radarr', url: 'http://192.168.1.10:7878', source: 'sweep' }
        ];
        const rows = await matchResults(found, parse({}), elsewhere);
        expect(rows).toHaveLength(1);
        expect(rows[0]).not.toHaveProperty('address');
    });

    it('keeps a sweep hit on another address, and another type on the same address, as their own rows', async () => {
        const lan = async (url: string) => (url === 'http://nas.lan:7878' ? 'http://192.168.1.10:7878' : url);
        const found: Found[] = [
            { type: 'radarr', url: 'http://nas.lan:7878', source: 'host' },
            { type: 'radarr', url: 'http://192.168.1.11:7878', source: 'sweep' },
            { type: 'sonarr', url: 'http://192.168.1.10:7878', source: 'sweep' }
        ];
        expect(await matchResults(found, parse({}), lan)).toHaveLength(3);
    });

    it('marks a merged row added when only its container url is the configured one', async () => {
        const config = parse({ radarr: block('http://radarr:7878') });
        const found: Found[] = [
            { type: 'radarr', url: 'http://nas.lan:7878', version: '5.0', source: 'host' },
            { type: 'radarr', url: 'http://radarr:7878', version: '5.0', source: 'container' }
        ];
        const rows = await matchResults(found, config, resolve);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ status: 'added', url: 'http://nas.lan:7878', alsoAt: 'http://radarr:7878' });
        expect(rows[0]?.existingUrl).toBeUndefined();
    });
});
