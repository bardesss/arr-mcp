import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import type { IndexInput } from '../src/core/resolver.ts';
import type { MediaServerAdapter, ServiceAdapter } from '../src/services/types.ts';
import { registerDiscoverMedia } from '../src/tools/discoverMedia.ts';
import { registerFixMetadata } from '../src/tools/fixMetadata.ts';
import { registerGetLibrary } from '../src/tools/getLibrary.ts';
import { registerGetMediaDetails } from '../src/tools/getMediaDetails.ts';
import { registerGetMetadataIssues } from '../src/tools/getMetadataIssues.ts';
import { registerGetPlayback } from '../src/tools/getPlayback.ts';
import { LibraryLoader } from '../src/tools/library.ts';
import { bothIds, type MediaServers } from '../src/tools/mediaServers.ts';
import { registerSetWatched } from '../src/tools/setWatched.ts';

/**
 * The surface a client actually sees, driven through real registrations.
 *
 * 1.0 froze it with two names inconsistent, and both old spellings keep working
 * forever while only the new ones are described. That property is only real at
 * the registration layer — the build functions below it speak one vocabulary —
 * so it has to be tested here.
 */

const film = (title: string, tmdb: number): IndexInput => ({
    kind: 'movie',
    title,
    ids: { tmdb },
    acquisition: { service: 'radarr', monitored: true, hasFile: true },
    playback: { user: 'Someone', watched: true }
});

const radarr = (): ServiceAdapter =>
    ({
        id: 'radarr',
        type: 'radarr',
        testConnection: async () => ({ ok: true, service: 'radarr', latency_ms: 1 }),
        getVersion: async () => '5.0.0',
        listLibrary: async () => [film('Have it', 1)]
    }) as unknown as ServiceAdapter;

type Handler = (args: Record<string, unknown>, extra: Record<string, unknown>) => Promise<{
    structuredContent?: Record<string, unknown>;
}>;

// The SDK stores a tool's callback as `handler`, the same as a prompt's, and
// calls it with (args, extra) — confirmed by inspecting a real registration.
const toolsOf = (register: (s: McpServer) => void): Record<string, { handler: Handler }> => {
    const server = new McpServer({ name: 'test', version: '0' });
    register(server);
    return (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;
};

const callLibrary = (args: Record<string, unknown>) =>
    toolsOf(s => registerGetLibrary(s, new LibraryLoader([radarr()], undefined))).get_library!.handler(
        { detail: 'standard', limit: 50, ...args },
        {}
    );

const callDiscover = (args: Record<string, unknown>) =>
    toolsOf(s => registerDiscoverMedia(s, undefined)).discover_media!.handler(
        { detail: 'standard', limit: 10, ...args },
        {}
    );

describe('discover_media speaks the vocabulary it answers in', () => {
    it('accepts `kind`, which is what the returned items carry', async () => {
        await expect(callDiscover({ kind: 'series' })).resolves.toBeDefined();
    });

    /** Never removed: dropping a spelling is the one change that breaks a saved
     *  prompt silently, which is what freezing the surface exists to stop. */
    it('still accepts the older media_type spelling', async () => {
        await expect(callDiscover({ media_type: 'tv' })).resolves.toBeDefined();
    });

    it('accepts both when they agree', async () => {
        await expect(callDiscover({ kind: 'series', media_type: 'tv' })).resolves.toBeDefined();
    });

    /** Refused rather than resolved: preferring one silently would make the
     *  answer depend on a precedence rule nobody wrote down. */
    it('refuses a request that contradicts itself', async () => {
        await expect(callDiscover({ kind: 'movie', media_type: 'tv' })).rejects.toThrow(/contradict/i);
    });
});

describe('get_library names a Jellyfin user the way every other tool does', () => {
    it('accepts `user`, as get_playback and get_requests already did', async () => {
        await expect(callLibrary({ user: 'Someone', watched: true })).resolves.toBeDefined();
    });

    it('still accepts the older watched_by spelling', async () => {
        await expect(callLibrary({ watched_by: 'Someone', watched: true })).resolves.toBeDefined();
    });

    it('refuses a request naming two different users', async () => {
        await expect(callLibrary({ user: 'Someone', watched_by: 'Someone Else' })).rejects.toThrow(/contradict/i);
    });
});

describe('what 1.0 documents', () => {
    /** An undocumented alias that is documented is not undocumented. */
    it('describes only the new spellings', () => {
        const discover = toolsOf(s => registerDiscoverMedia(s, undefined)).discover_media as unknown as {
            inputSchema: { shape: Record<string, { description?: string }> };
        };
        expect(discover.inputSchema.shape.kind?.description).toBeDefined();
        expect(discover.inputSchema.shape.media_type?.description).toBeUndefined();
    });
});

describe('get_library on one media server', () => {
    const shapeOf = (ids?: [string, string]) => {
        const server = new McpServer({ name: 'test', version: '0' });
        registerGetLibrary(server, new LibraryLoader([radarr()], undefined), ids);
        const tool = (server as unknown as { _registeredTools: Record<string, { inputSchema: { shape: Record<string, unknown> } }> })._registeredTools.get_library!;
        return Object.keys(tool.inputSchema.shape);
    };

    it('does not offer missing_from', () => {
        expect(shapeOf()).not.toContain('missing_from');
    });

    it('offers missing_from with both', () => {
        expect(shapeOf(['jellyfin', 'plex'])).toContain('missing_from');
    });
});

describe('tool descriptions on one media server', () => {
    const server = (type: 'jellyfin' | 'plex') => ({ id: type, type }) as unknown as MediaServerAdapter;
    const single: MediaServers = { primary: { adapter: server('jellyfin'), identity: undefined } };
    const dual: MediaServers = {
        primary: { adapter: server('plex'), identity: undefined },
        secondary: { adapter: server('jellyfin'), identity: undefined }
    };
    const loader = new LibraryLoader([radarr()], undefined);
    const write = { permissions: permissionSourceFrom([]), confirm: new ConfirmTokens(), audit: WriteAudit.ephemeral(), library: loader };

    type Registered = { description?: string; inputSchema?: { shape: Record<string, { description?: string }> }; outputSchema?: { shape: Record<string, { description?: string }> } };
    const textOf = (servers: MediaServers): Record<string, string> => {
        const ids = bothIds(servers);
        const s = new McpServer({ name: 'test', version: '0' });
        registerGetLibrary(s, loader, ids);
        registerGetPlayback(s, servers);
        registerGetMetadataIssues(s, servers);
        registerFixMetadata(s, write, servers, loader);
        registerGetMediaDetails(s, [], loader, undefined, ids);
        registerSetWatched(s, write, [], undefined, ids);
        const tools = (s as unknown as { _registeredTools: Record<string, Registered> })._registeredTools;
        const names = ['get_library', 'get_playback', 'get_metadata_issues', 'fix_metadata', 'get_media_details', 'set_watched'];
        return Object.fromEntries(
            names.map(name => {
                const t = tools[name]!;
                const fields = [...Object.values(t.inputSchema?.shape ?? {}), ...Object.values(t.outputSchema?.shape ?? {})];
                return [name, [t.description ?? '', ...fields.map(f => f.description ?? '')].join('\n')];
            })
        );
    };
    const DUAL_ONLY = /two media servers|media_servers|primary media server|`service` picks/;

    it('says nothing about a second server', () => {
        for (const [name, text] of Object.entries(textOf(single))) expect(text, name).not.toMatch(DUAL_ONLY);
    });

    it('says it with two', () => {
        for (const [name, text] of Object.entries(textOf(dual))) expect(text, name).toMatch(DUAL_ONLY);
    });
});