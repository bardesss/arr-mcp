import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import type { ServiceInstance } from '../src/config/instances.ts';
import type { IndexInput } from '../src/core/resolver.ts';
import { registerAllResources } from '../src/mcp/resources.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import { buildStackHealth } from '../src/tools/stackHealth.ts';
import { LibraryLoader } from '../src/tools/library.ts';
import type { ToolContext } from '../src/tools/register.ts';

/**
 * The resources, read through a real `McpServer` registration rather than by
 * calling the callbacks directly — the registration itself (uri, mimeType,
 * cacheHint) is half of what is being asserted.
 */

const film = (title: string, tmdb: number, hasFile: boolean): IndexInput => ({
    kind: 'movie',
    title,
    ids: { tmdb },
    acquisition: { service: 'radarr', monitored: true, hasFile }
});

const LIBRARY: IndexInput[] = [film('Have it', 1, true), film('Waiting', 2, false)];

const radarr = (): ServiceAdapter =>
    ({
        id: 'radarr/4k',
        type: 'radarr',
        testConnection: async () => ({ ok: true, service: 'radarr/4k', latency_ms: 1, version: '5.0.0' }),
        getVersion: async () => '5.0.0',
        listLibrary: async () => LIBRARY
    }) as unknown as ServiceAdapter;

const instance = (id: string, safe_write: boolean, destructive: boolean): ServiceInstance =>
    ({
        id,
        type: id.split('/')[0],
        config: { permissions: { safe_write, destructive } }
    }) as unknown as ServiceInstance;

const INSTANCES = [instance('radarr/4k', true, false), instance('sonarr', false, false)];

const context = (): ToolContext =>
    ({
        adapters: [radarr()],
        instances: INSTANCES,
        library: new LibraryLoader([radarr()], undefined)
    }) as unknown as ToolContext;

/** The registry the SDK builds, which is what a client actually sees. */
const registered = () => {
    const server = new McpServer({ name: 'test', version: '0' });
    registerAllResources(server, context());
    return (server as unknown as { _registeredResources: Record<string, Record<string, unknown>> })
        ._registeredResources;
};

const read = async (uri: string): Promise<Record<string, unknown>> => {
    const entry = registered()[uri] as { readCallback: (u: URL) => unknown } | undefined;
    if (entry === undefined) throw new Error(`${uri} is not registered`);
    const result = (await entry.readCallback(new URL(uri))) as { contents: { text: string }[] };
    return JSON.parse(result.contents[0]!.text) as Record<string, unknown>;
};

const ALL = ['arr://instances', 'arr://health', 'arr://library/summary'];

describe('the resources a client sees', () => {
    it('registers all three', () => {
        expect(Object.keys(registered()).sort()).toEqual([...ALL].sort());
    });

    it('names every instance a tool would accept as `instance`', async () => {
        const body = (await read('arr://instances')) as { instances: { id: string; safe_write: boolean }[] };
        expect(body.instances.map(i => i.id)).toEqual(['radarr/4k', 'sonarr']);
        expect(body.instances[0]?.safe_write).toBe(true);
    });

    it('summarises the library as total, on disk and still wanted', async () => {
        expect(await read('arr://library/summary')).toMatchObject({ total: 2, on_disk: 1, wanted: 1 });
    });
});

/**
 * A cache hint is advice a client may ignore; a timestamp inside the content
 * cannot be dropped without dropping the content. A reader must never have to
 * guess when a number was true.
 */
describe('saying when it was true', () => {
    it('stamps every resource with an as_of', async () => {
        for (const uri of ALL) {
            expect(await read(uri)).toMatchObject({ as_of: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
        }
    });
});

describe('cache hints', () => {
    // The SDK hangs cacheHint off the registration itself, beside `metadata`
    // rather than inside it — confirmed by inspecting a real registration
    // rather than inferred from the config object's shape.
    const hintFor = (uri: string) => (registered()[uri] as { cacheHint?: { ttlMs?: number } }).cacheHint;

    /**
     * A pinned "sonarr: reachable" five hours after Sonarr fell over is worse
     * than the tool call it replaced — confidently wrong rather than absent.
     */
    it('forbids caching live health', () => {
        expect(hintFor('arr://health')?.ttlMs).toBe(0);
    });

    it('permits caching the config-shaped one, which only an edit invalidates', () => {
        expect(hintFor('arr://instances')?.ttlMs).toBeGreaterThan(0);
    });

    it('caches the summary for less time than the instance list', () => {
        expect(hintFor('arr://library/summary')?.ttlMs).toBeLessThan(hintFor('arr://instances')?.ttlMs ?? 0);
    });
});

/**
 * The rule the whole phase rests on, asserted rather than assumed: client
 * support for resources is uneven, so anything only a resource could answer
 * would be unreachable wherever they are not surfaced.
 */
describe('mirroring, never originating', () => {
    it('exposes no instance stack_health cannot also report', async () => {
        const body = (await read('arr://instances')) as {
            instances: { id: string; safe_write: boolean; destructive: boolean }[];
        };
        const health = await buildStackHealth([radarr()], { detail: 'standard', limit: 50 }, INSTANCES);

        for (const i of body.instances) {
            expect(health.permissions).toContainEqual({
                instance: i.id,
                safe_write: i.safe_write,
                destructive: i.destructive
            });
        }
    });

    it('says outright that stack_health is the live answer', () => {
        const health = registered()['arr://health'] as { metadata?: { description?: string } };
        expect(health.metadata?.description).toContain('stack_health');
    });
});
