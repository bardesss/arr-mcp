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

const radarr = (library: IndexInput[] = LIBRARY): ServiceAdapter =>
    ({
        id: 'radarr/4k',
        type: 'radarr',
        testConnection: async () => ({ ok: true, service: 'radarr/4k', latency_ms: 1, version: '5.0.0' }),
        getVersion: async () => '5.0.0',
        listLibrary: async () => library
    }) as unknown as ServiceAdapter;

const instance = (id: string, safe_write: boolean, destructive: boolean): ServiceInstance =>
    ({
        id,
        type: id.split('/')[0],
        // Every real `ServiceInstance` carries a `url` — the config schema
        // requires one, and `get_stack_health`'s `endpoints` reads it. A stand-in
        // without it is a shape production cannot produce.
        config: { url: 'http://192.0.2.10:7878', permissions: { safe_write, destructive } }
    }) as unknown as ServiceInstance;

const INSTANCES = [instance('radarr/4k', true, false), instance('sonarr', false, false)];

/**
 * A Lidarr whose artist policies are the interesting shape: one that will keep
 * discovering new albums, one that will not.
 */
const POLICIES = [
    { artistId: '1', artistName: 'Auto', monitored: true, monitorNewItems: 'all' },
    { artistId: '2', artistName: 'Settled', monitored: false, monitorNewItems: 'none' }
];

const lidarrOn = (policies = POLICIES): ServiceAdapter =>
    ({
        id: 'lidarr',
        type: 'lidarr',
        getVersion: async () => '3.1.6.5078',
        listArtistMonitorPolicies: async () => policies,
        setArtistMonitorPolicy: async () => {}
    }) as unknown as ServiceAdapter;

/** One of several Lidarrs, which is how a lossless library beside a lossy one
 *  is configured. `down` stands for an instance that does not answer. */
const lidarrNamed = (name: string, policies: typeof POLICIES | 'down'): ServiceAdapter =>
    ({
        id: `lidarr/${name}`,
        type: 'lidarr',
        instance: name,
        getVersion: async () => '3.1.6.5078',
        listArtistMonitorPolicies: async () => {
            if (policies === 'down') throw new Error('connect ECONNREFUSED');
            return policies;
        },
        setArtistMonitorPolicy: async () => {}
    }) as unknown as ServiceAdapter;

const context = (extra: ServiceAdapter[] = [], library: IndexInput[] = LIBRARY): ToolContext =>
    ({
        adapters: [radarr(library), ...extra],
        instances: INSTANCES,
        library: new LibraryLoader([radarr(library), ...extra], undefined)
    }) as unknown as ToolContext;

/** The registry the SDK builds, which is what a client actually sees. */
const registered = (ctx: ToolContext = context()) => {
    const server = new McpServer({ name: 'test', version: '0' });
    registerAllResources(server, ctx);
    return (server as unknown as { _registeredResources: Record<string, Record<string, unknown>> })
        ._registeredResources;
};

const read = async (uri: string, ctx?: ToolContext): Promise<Record<string, unknown>> => {
    const entry = registered(ctx)[uri] as { readCallback: (u: URL) => unknown } | undefined;
    if (entry === undefined) throw new Error(`${uri} is not registered`);
    const result = (await entry.readCallback(new URL(uri))) as { contents: { text: string }[] };
    return JSON.parse(result.contents[0]!.text) as Record<string, unknown>;
};

/** A library with one row the service is not watching, which is what the
 *  summary note explains. */
const CATALOGUE: IndexInput[] = [
    film('Have it', 1, true),
    { kind: 'movie', title: 'Catalog', ids: { tmdb: 2 }, acquisition: { service: 'radarr', monitored: false, hasFile: false } }
];

const ALL = ['arr://instances', 'arr://health', 'arr://library/summary', 'arr://lidarr/monitoring'];

describe('the resources a client sees', () => {
    it('registers all four, beside the tool references', () => {
        expect(Object.keys(registered()).filter(u => !u.startsWith('arr://docs/')).sort()).toEqual([...ALL].sort());
    });

    it('serves each tool reference as text (#518)', async () => {
        const docs = Object.keys(registered()).filter(u => u.startsWith('arr://docs/'));
        expect(docs).toContain('arr://docs/get_library');
        const resource = registered()['arr://docs/get_library'] as unknown as {
            readCallback: (uri: URL) => { contents: { text: string; mimeType: string }[] };
        };
        const [content] = resource.readCallback(new URL('arr://docs/get_library')).contents;
        expect(content?.mimeType).toBe('text/markdown');
        expect(content?.text).toMatch(/jellyfin_only/);
    });

    it('names every instance a tool would accept as `instance`', async () => {
        const body = (await read('arr://instances')) as { instances: { id: string; safe_write: boolean }[] };
        expect(body.instances.map(i => i.id)).toEqual(['radarr/4k', 'sonarr']);
        expect(body.instances[0]?.safe_write).toBe(true);
    });

    it('summarises the library as total, on disk and still wanted', async () => {
        expect(await read('arr://library/summary')).toMatchObject({ total: 2, on_disk: 1, wanted: 1 });
    });

    /**
     * The trap this closes: a Lidarr library that is finished reads as tens of
     * thousands of items because the whole discography sits in it unmonitored.
     * `total` alone made that look like a library size, so `monitored` and the
     * note have to say which number is the library.
     */
    it('separates what is watched from what is only catalog', async () => {
        const body = await read('arr://library/summary');

        expect(body).toMatchObject({ total: 2, monitored: 2, unmonitored: 0 });
        expect(body.note).toBeUndefined();
    });

    /**
     * Unmonitored rows are not evidence of Lidarr. Without one configured, the
     * cause is whichever service holds them, and naming a service the reader
     * does not run sends them to the wrong config file.
     */
    it('names no service as the cause when no Lidarr is configured', async () => {
        const body = await read('arr://library/summary', context([], CATALOGUE));

        expect(body).toMatchObject({ total: 2, monitored: 1, unmonitored: 1 });
        expect(String(body.note)).toContain('nothing is pending on those');
        expect(String(body.note)).not.toContain('Lidarr');
    });

    it('names Lidarr as the usual source when Lidarr is configured', async () => {
        const body = await read('arr://library/summary', context([lidarrOn()], CATALOGUE));

        expect(String(body.note)).toContain('Lidarr is the usual source');
    });

    describe('lidarr monitoring policy', () => {
        it('says absent rather than zero when no Lidarr is configured', async () => {
            const body = await read('arr://lidarr/monitoring');

            expect(body).toMatchObject({ configured: false });
            expect(body.artists).toBeUndefined();
        });

        it('counts who will keep discovering albums, and calls that unstable', async () => {
            const body = await read('arr://lidarr/monitoring', context([lidarrOn()]));

            expect(body).toMatchObject({
                configured: true,
                artists: 2,
                monitor_new_items: { all: 1, none: 1 },
                artist_flag: { monitored: 1, unmonitored: 1 },
                stable: false
            });
            expect(String(body.note)).toContain('treadmill');
            // One Lidarr keeps the shape it had before a second one could exist.
            expect(body.instances).toBeUndefined();
            expect(body.degraded).toBeUndefined();
        });

        /**
         * Reading only the first would report one instance's policy as if it
         * were the whole music library's, and a settled lossless library would
         * hide a lossy one still discovering albums.
         */
        it('reads every Lidarr, and reports each one beside the totals', async () => {
            const settled = [{ artistId: '1', artistName: 'Settled', monitored: false, monitorNewItems: 'none' }];
            const body = await read(
                'arr://lidarr/monitoring',
                context([lidarrNamed('flac', settled), lidarrNamed('mp3', POLICIES)])
            );

            expect(body).toMatchObject({
                configured: true,
                artists: 3,
                monitor_new_items: { all: 1, none: 2 },
                artist_flag: { monitored: 1, unmonitored: 2 },
                stable: false,
                instances: [
                    { service: 'lidarr/flac', artists: 1, stable: true },
                    { service: 'lidarr/mp3', artists: 2, stable: false, monitor_new_items: { all: 1, none: 1 } }
                ]
            });
            expect(body.degraded).toBeUndefined();
            // With two Lidarrs, update_media without `instance` is refused, and
            // the totals add the instances up rather than merging artists.
            expect(String(body.note)).toMatch(/^1 artist\(s\) \(counted once per instance\) will keep monitoring/);
            expect(String(body.note)).toMatch(/update_media with no `id` and `instance` does it\.$/);
        });

        it('says so in the plural when none of several Lidarrs holds an artist', async () => {
            const body = await read('arr://lidarr/monitoring', context([lidarrNamed('flac', []), lidarrNamed('mp3', [])]));

            expect(body).toMatchObject({ artists: 0, stable: true });
            expect(String(body.note)).toMatch(/^None of these Lidarrs holds any artists, so they report no monitoring policy/);
        });

        it('names a Lidarr that did not answer, and does not call the rest stable', async () => {
            const settled = [{ artistId: '1', artistName: 'Settled', monitored: false, monitorNewItems: 'none' }];
            const body = await read(
                'arr://lidarr/monitoring',
                context([lidarrNamed('flac', settled), lidarrNamed('mp3', 'down')])
            );

            expect(body).toMatchObject({
                configured: true,
                artists: 1,
                stable: false,
                degraded: ['lidarr/mp3'],
                instances: [{ service: 'lidarr/flac', artists: 1, stable: true }]
            });
            // The instance that answered is settled, but the one that did not may
            // be growing the wanted list, so the note must not say it cannot grow.
            expect(body.note).toBe(
                'lidarr/mp3 could not be read, which is not the same as its policy being off, so the counts cover ' +
                    'only the rest and cannot say the wanted list will not grow.'
            );
        });

        it('says "their policies" when more than one Lidarr did not answer', async () => {
            const settled = [{ artistId: '1', artistName: 'Settled', monitored: false, monitorNewItems: 'none' }];
            const body = await read(
                'arr://lidarr/monitoring',
                context([lidarrNamed('flac', settled), lidarrNamed('mp3', 'down'), lidarrNamed('ogg', 'down')])
            );

            expect(body).toMatchObject({ degraded: ['lidarr/mp3', 'lidarr/ogg'], stable: false });
            expect(String(body.note)).toMatch(/^lidarr\/mp3, lidarr\/ogg could not be read, which is not the same as their policies being off/);
        });

        it('joins the unread instance to the treadmill note when an answering one still auto-monitors', async () => {
            const body = await read('arr://lidarr/monitoring', context([lidarrNamed('flac', POLICIES), lidarrNamed('mp3', 'down')]));

            expect(body).toMatchObject({ degraded: ['lidarr/mp3'], stable: false, instances: [{ service: 'lidarr/flac', artists: 2 }] });
            expect(body.note).toBe(
                'lidarr/mp3 could not be read, which is not the same as its policy being off, so the counts cover only the rest ' +
                    'and cannot say the wanted list will not grow. 1 artist(s) (counted once per instance) will keep monitoring ' +
                    'albums they discover later, or report no readable policy. Unmonitoring albums under those artists is a ' +
                    'treadmill until the policy changes; update_media with no `id` and `instance` does it.'
            );
        });

        it('keeps the single-Lidarr treadmill note word for word', async () => {
            const body = await read('arr://lidarr/monitoring', context([lidarrOn()]));

            expect(body.note).toBe(
                '1 artist(s) will keep monitoring albums they discover later, or report no readable policy. ' +
                    'Unmonitoring albums under those artists is a treadmill until the policy changes; update_media ' +
                    'with no `id` does it.'
            );
        });

        it('calls several settled Lidarrs stable', async () => {
            const settled = [{ artistId: '1', artistName: 'Settled', monitored: false, monitorNewItems: 'none' }];
            const body = await read('arr://lidarr/monitoring', context([lidarrNamed('flac', settled), lidarrNamed('mp3', settled)]));

            expect(body).toMatchObject({ artists: 2, stable: true });
            expect(String(body.note)).toMatch(/^No artist will monitor an album it discovers later/);
        });

        it('keeps the single-Lidarr shape for a list holding one entry', async () => {
            const body = await read('arr://lidarr/monitoring', context([lidarrNamed('flac', POLICIES)]));

            expect(body).toMatchObject({ configured: true, artists: 2, stable: false });
            expect(body.instances).toBeUndefined();
            expect(body.degraded).toBeUndefined();
            expect(String(body.note)).toMatch(/update_media with no `id` does it\.$/);
        });

        it('keeps the old body for one unnamed Lidarr that cannot be read', async () => {
            const down = {
                ...lidarrOn(),
                listArtistMonitorPolicies: async () => {
                    throw new Error('connect ECONNREFUSED');
                }
            } as unknown as ServiceAdapter;
            const body = await read('arr://lidarr/monitoring', context([down]));

            const { as_of: _asOf, ...rest } = body;
            expect(rest).toEqual({
                configured: true,
                artists: 0,
                stable: false,
                note: 'The policy could not be read, which is not the same as it being off. Call update_media with no `id` for the live answer.'
            });
        });

        it('says the policy could not be read when no Lidarr answered', async () => {
            const body = await read('arr://lidarr/monitoring', context([lidarrNamed('flac', 'down'), lidarrNamed('mp3', 'down')]));

            expect(body).toMatchObject({ configured: true, stable: false, degraded: ['lidarr/flac', 'lidarr/mp3'] });
            expect(body.note).toBe(
                'The policies could not be read, which is not the same as them being off. Call update_media ' +
                    'with no `id` and `instance` for the live answer.'
            );
        });

        it('calls a library stable only when no artist will auto-monitor', async () => {
            const settled = [{ artistId: '1', artistName: 'Settled', monitored: false, monitorNewItems: 'none' }];
            const body = await read('arr://lidarr/monitoring', context([lidarrOn(settled)]));

            expect(body).toMatchObject({ stable: true });
        });

        /**
         * Zero artists used to report `stable: false` beside a note saying
         * nothing could grow, which a reader cannot reconcile. Nothing in an
         * empty list can grow the wanted list, so the flag follows the note.
         */
        it('calls an empty artist list stable, and says why', async () => {
            const body = await read('arr://lidarr/monitoring', context([lidarrOn([])]));

            expect(body).toMatchObject({ configured: true, artists: 0, stable: true });
            expect(String(body.note)).toContain('holds no artists');
            expect(String(body.note)).not.toContain('treadmill');
        });

        /**
         * A policy that could not be read is not a policy that is off, so it
         * counts against stability rather than being defaulted to the safe value.
         */
        it('counts an unreadable policy against stability, not for it', async () => {
            const odd = [{ artistId: '1', artistName: 'Odd', monitored: false, monitorNewItems: 'unknown' }];
            const body = await read('arr://lidarr/monitoring', context([lidarrOn(odd)]));

            expect(body).toMatchObject({ stable: false, monitor_new_items: { unknown: 1 } });
        });
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
    it('exposes no instance get_stack_health cannot also report', async () => {
        const body = (await read('arr://instances')) as {
            instances: { id: string; safe_write: boolean; destructive: boolean }[];
        };
        const health = await buildStackHealth([radarr()], { detail: 'full', limit: 50 }, INSTANCES);

        for (const i of body.instances) {
            expect(health.permissions).toContainEqual({
                instance: i.id,
                safe_write: i.safe_write,
                destructive: i.destructive
            });
        }
    });

    it('says outright that get_stack_health is the live answer', () => {
        const health = registered()['arr://health'] as { metadata?: { description?: string } };
        expect(health.metadata?.description).toContain('get_stack_health');
    });
});
