import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import { serviceOf, type ServiceId } from '../src/config/schema.ts';
import type { IndexInput } from '../src/core/resolver.ts';
import { leanJsonSchema, leanSchema, scopeText, shapeToolSurface, type SurfaceOptions } from '../src/mcp/toolSurface.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import { buildGetLibrary } from '../src/tools/getLibrary.ts';
import { LibraryLoader } from '../src/tools/library.ts';

// #518: what tools/list sends, trimmed and tailored to the configured stack.

const on = (...types: ServiceId[]): SurfaceOptions => ({ configured: new Set(types), hideUnusable: false });
const nothing = on();

describe('the JSON a schema sends', () => {
    it('drops $schema and the 2^53 bounds a bare int carries', () => {
        const json = leanJsonSchema(
            {
                $schema: 'https://json-schema.org/draft/2020-12/schema',
                type: 'object',
                properties: {
                    season: { type: 'integer', minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
                    limit: { type: 'integer', minimum: 1, maximum: 500 }
                }
            },
            'input',
            nothing
        ) as { properties: Record<string, Record<string, unknown>> };
        expect(json).not.toHaveProperty('$schema');
        expect(json.properties['season']).toEqual({ type: 'integer' });
        expect(json.properties['limit']).toEqual({ type: 'integer', minimum: 1, maximum: 500 });
    });

    it('drops field descriptions from an output schema, but not a field called description', () => {
        const json = leanJsonSchema(
            {
                type: 'object',
                description: 'the result',
                properties: { description: { type: 'string', description: 'the book blurb' }, items: { type: 'array', items: { type: 'object', description: 'a row' } } }
            },
            'output',
            nothing
        ) as { description?: string; properties: Record<string, Record<string, unknown>> };
        expect(json.description).toBe('the result');
        expect(json.properties['description']).toEqual({ type: 'string' });
        expect(json.properties['items']).toEqual({ type: 'array', items: { type: 'object' } });
    });

    it('keeps input field descriptions', () => {
        const json = leanJsonSchema({ type: 'object', properties: { id: { type: 'string', description: 'The id.' } } }, 'input', nothing) as {
            properties: Record<string, { description?: string }>;
        };
        expect(json.properties['id']?.description).toBe('The id.');
    });

    const scoped = (opts: SurfaceOptions) =>
        leanJsonSchema(
            {
                type: 'object',
                required: ['id', 'title'],
                properties: {
                    id: { type: 'string', description: 'The id.' },
                    title: { type: 'string', description: '[[grimmory: The new title.]]' },
                    monitored: { type: 'boolean', description: 'Monitor it[[lidarr: , the artist flag]].' }
                }
            },
            'input',
            opts
        ) as { required: string[]; properties: Record<string, { description?: string }> };

    it('drops a field whose description is wholly scoped to an absent service, and its required entry', () => {
        const json = scoped(on('radarr'));
        expect(Object.keys(json.properties)).toEqual(['id', 'monitored']);
        expect(json.required).toEqual(['id']);
        expect(json.properties['monitored']?.description).toBe('Monitor it.');
    });

    it('keeps it when the service is configured, or nothing is', () => {
        for (const opts of [on('grimmory'), nothing]) {
            const json = scoped(opts);
            expect(Object.keys(json.properties)).toEqual(['id', 'title', 'monitored']);
            expect(json.required).toEqual(['id', 'title']);
            expect(json.properties['title']?.description).toBe('The new title.');
        }
    });
});

describe('a service field', () => {
    const shape = () => z.object({ service: serviceOf(['radarr', 'sonarr', 'lidarr']) });
    const advertised = (opts: SurfaceOptions): unknown => {
        const view = leanSchema(shape(), opts) as unknown as { '~standard': { jsonSchema: { input: (o: unknown) => { properties: { service: { enum: unknown } } } } } };
        return view['~standard'].jsonSchema.input({ target: 'draft-2020-12' }).properties.service.enum;
    };

    it('lists only the services the tool takes', () => {
        expect(advertised(nothing)).toEqual(['radarr', 'sonarr', 'lidarr']);
    });

    it('lists only the configured ones among those', () => {
        expect(advertised(on('radarr', 'jellyfin'))).toEqual(['radarr']);
    });

    it('still lists the tool’s own services when none is configured, so a call stays writable', () => {
        expect(advertised(on('jellyfin'))).toEqual(['radarr', 'sonarr', 'lidarr']);
    });

    it('still accepts every service id, so the tool can refuse with its own remedy', () => {
        const view = leanSchema(shape(), on('radarr'));
        expect(view.safeParse({ service: 'bazarr' }).success).toBe(true);
    });

    it('leaves the shared schema itself alone', () => {
        const schema = shape();
        leanSchema(schema, on('radarr'));
        const own = (schema as unknown as { '~standard': { jsonSchema: { input: (o: unknown) => Record<string, unknown> } } })['~standard'].jsonSchema.input({
            target: 'draft-2020-12'
        });
        expect(own).toHaveProperty('$schema');
    });
});

describe('description scopes', () => {
    const text = 'Reads the queue. [[lidarr: An artist row has albums.]] [[transmission|qbittorrent: A torrent carries `seeding`.]] Done.';

    it('keeps a scope when one of its services is configured', () => {
        expect(scopeText(text, on('qbittorrent'))).toBe('Reads the queue. A torrent carries `seeding`. Done.');
    });

    it('keeps every scope before anything is configured', () => {
        expect(scopeText(text, nothing)).toBe('Reads the queue. An artist row has albums. A torrent carries `seeding`. Done.');
    });

    it('drops a scope inside a sentence without leaving a gap before punctuation', () => {
        expect(scopeText('`downloadId` links a row to its grab[[nzbget: ; on NZBGet it reruns post-processing]].', on('radarr'))).toBe(
            '`downloadId` links a row to its grab.'
        );
    });
});

describe('the tool list', () => {
    const tools = (opts: SurfaceOptions) => {
        const server = shapeToolSurface(new McpServer({ name: 't', version: '0' }), opts);
        for (const name of ['get_queue', 'get_subtitles', 'sync_database']) {
            server.registerTool(name, { description: `${name}. [[bazarr: Bazarr text.]]`, inputSchema: z.object({}) }, async () => ({ content: [] }));
        }
        return (server as unknown as { _registeredTools: Record<string, { description?: string }> })._registeredTools;
    };

    /** The same, with `sync_database` as a write and the other two as reads. */
    const mixed = (opts: SurfaceOptions) => {
        const server = shapeToolSurface(new McpServer({ name: 't', version: '0' }), opts);
        const add = (name: string, annotations: Record<string, boolean>) =>
            server.registerTool(name, { description: name, inputSchema: z.object({}), annotations }, async () => ({ content: [] }));
        add('sync_database', { readOnlyHint: false, destructiveHint: false });
        add('get_subtitles', { readOnlyHint: true });
        add('get_queue', { readOnlyHint: true });
        return (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    };

    it('keeps every tool unless hide_unusable is on', () => {
        expect(Object.keys(tools(on('radarr')))).toEqual(['get_queue', 'get_subtitles', 'sync_database']);
    });

    it('hides tools none of whose services is configured, with hide_unusable', () => {
        expect(Object.keys(tools({ configured: new Set(['radarr', 'bazarr']), hideUnusable: true }))).toEqual(['get_queue', 'get_subtitles']);
    });

    it('hides nothing before anything is configured', () => {
        expect(Object.keys(tools({ configured: new Set(), hideUnusable: true }))).toHaveLength(3);
    });

    it('hides a write tool none of whose services is configured, without hide_unusable', () => {
        expect(Object.keys(mixed(on('radarr'))).sort()).toEqual(['get_queue', 'get_subtitles']);
    });

    it('keeps that write tool before anything is configured', () => {
        expect(Object.keys(mixed(nothing))).toHaveLength(3);
    });

    it('keeps a write tool whose service is configured', () => {
        expect(Object.keys(mixed(on('profilarr')))).toContain('sync_database');
    });

    it('resolves description scopes', () => {
        expect(tools(on('radarr'))['get_queue']?.description).toBe('get_queue.');
        expect(tools(on('bazarr'))['get_queue']?.description).toBe('get_queue. Bazarr text.');
    });
});

describe('get_library folder paths', () => {
    const film: IndexInput = {
        kind: 'movie',
        title: 'Some Film',
        ids: { tmdb: 1 },
        acquisition: { service: 'radarr', monitored: true, hasFile: true, path: '/movies/Some Film (2026)' }
    };
    const loader = new LibraryLoader(
        [{ id: 'radarr', type: 'radarr', testConnection: async () => ({ ok: true }), getVersion: async () => '1', listLibrary: async () => [film] } as unknown as ServiceAdapter],
        undefined
    );

    it('leaves the path out at standard', async () => {
        const { items } = await buildGetLibrary(loader, { detail: 'standard', limit: 50 });
        expect(items[0]?.acquisition).not.toHaveProperty('path');
        expect(items[0]?.acquisition?.monitored).toBe(true);
    });

    it('keeps it at full', async () => {
        const { items } = await buildGetLibrary(loader, { detail: 'full', limit: 50 });
        expect(items[0]?.acquisition?.path).toBe('/movies/Some Film (2026)');
    });
});
