import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import type { IndexInput } from '../src/core/resolver.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import { registerDiscoverMedia } from '../src/tools/discoverMedia.ts';
import { registerGetLibrary } from '../src/tools/getLibrary.ts';
import { LibraryLoader } from '../src/tools/library.ts';

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
