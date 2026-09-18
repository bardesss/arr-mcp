import { describe, expect, it } from 'vitest';
import type { OAuthConfig } from '../src/config/schema.ts';
import { resourceMetadata, resourceMetadataUrl } from '../src/mcp/resourceMetadata.ts';

const oauth: OAuthConfig = {
    issuer: 'https://auth.example.com',
    audience: 'arr-mcp',
    jwks_uri: 'https://auth.example.com/.well-known/jwks.json',
    scopes: { read: 'arr-mcp:read', write: 'arr-mcp:write', destructive: 'arr-mcp:destructive' }
};

describe('resourceMetadata', () => {
    it('names this server as the resource and the issuer as the authorization server', () => {
        expect(resourceMetadata(oauth, 'http://192.0.2.10:6060/.well-known/oauth-protected-resource/mcp', undefined)).toEqual({
            resource: 'http://192.0.2.10:6060/mcp',
            authorization_servers: ['https://auth.example.com'],
            scopes_supported: ['arr-mcp:read', 'arr-mcp:write', 'arr-mcp:destructive'],
            resource_name: 'arr-mcp',
            resource_documentation: undefined
        });
    });

    it('advertises renamed scopes rather than the defaults', () => {
        const renamed = { ...oauth, scopes: { read: 'media:read', write: 'media:write', destructive: 'media:delete' } };
        expect(resourceMetadata(renamed, 'http://host:6060/mcp', undefined)?.scopes_supported).toEqual([
            'media:read',
            'media:write',
            'media:delete'
        ]);
    });

    // X-Forwarded-Proto is the only forwarded header origin.ts reads, and
    // omitting it hands out an http:// URL that cannot work behind TLS.
    it('honours a TLS-terminating proxy', () => {
        expect(resourceMetadata(oauth, 'http://arr.example.com/mcp', 'https')?.resource).toBe('https://arr.example.com/mcp');
    });

    // Host is attacker-controlled and Node's parser forwards bytes that are
    // legal in a header but illegal in a URL host.
    it('refuses to build a document from a Host it cannot trust', () => {
        expect(resourceMetadata(oauth, 'http://evil host/mcp', undefined)).toBeUndefined();
        expect(resourceMetadataUrl('http://evil host/mcp', undefined)).toBeUndefined();
    });
});

describe('resourceMetadataUrl', () => {
    it('inserts the well-known segment ahead of the endpoint path', () => {
        expect(resourceMetadataUrl('http://192.0.2.10:6060/mcp', undefined)).toBe(
            'http://192.0.2.10:6060/.well-known/oauth-protected-resource/mcp'
        );
    });
});
