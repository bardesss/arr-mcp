import { describe, expect, it } from 'vitest';
import { setImdb, setMcpEndpoint } from '../src/config/edits.ts';
import { addCandidate, ConfigEditError } from '../src/config/mutate.ts';
import { ConfigSchema, type Config } from '../src/config/schema.ts';

const base = (): Config => ConfigSchema.parse({ auth: { username: 'admin' }, services: {} });
const withOAuth = (): Config =>
    ConfigSchema.parse({
        auth: {
            username: 'admin',
            oauth: { issuer: 'https://id.example.com', audience: 'arr-mcp', jwks_uri: 'https://id.example.com/jwks' }
        },
        services: {}
    });

describe('setImdb', () => {
    it('writes the block when on and drops it when off', () => {
        const on = setImdb(base(), true);
        expect(on.metadata).toEqual({ imdb: { enabled: true } });
        expect('metadata' in setImdb(on, false)).toBe(false);
    });
});

describe('setMcpEndpoint', () => {
    it('trims and drops blank hosts', () => {
        expect(setMcpEndpoint(base(), { allowedHosts: [' arr.example.com ', ''] }).auth.allowed_hosts).toEqual([
            'arr.example.com'
        ]);
    });

    it('leaves an omitted field as it was', () => {
        const pinned = setMcpEndpoint(base(), { allowedHosts: ['arr.example.com'] });
        const next = setMcpEndpoint(pinned, { allowTokenInUrl: true });
        expect(next.auth.allowed_hosts).toEqual(['arr.example.com']);
        expect(next.auth.allow_token_in_url).toBe(true);
    });

    it('refuses the URL token while OAuth is configured', () => {
        expect(() => setMcpEndpoint(withOAuth(), { allowTokenInUrl: true })).toThrow(ConfigEditError);
    });
});

describe('addCandidate', () => {
    it('returns the candidate and the id it will take', () => {
        const { candidate, target } = addCandidate(base(), {
            type: 'radarr',
            name: undefined,
            fields: { url: 'http://radarr:7878', api_key: 'k' }
        });
        expect(target).toBe('radarr');
        expect(candidate.services.radarr).toBeDefined();
    });
});
