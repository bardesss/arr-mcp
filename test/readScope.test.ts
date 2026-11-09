import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import type { KeyedServiceConfig } from '../src/config/schema.ts';
import { RadarrAdapter } from '../src/services/radarr.ts';
import type { ServiceAdapter } from '../src/services/types.ts';
import { buildGetBlocklist } from '../src/tools/getBlocklist.ts';
import { buildGetWanted } from '../src/tools/getWanted.ts';
import { registerLookupMedia } from '../src/tools/lookupMedia.ts';
import { registerSearchMedia } from '../src/tools/searchMedia.ts';
import { serving } from './helpers/serve.ts';

type Result = { content: { type: string; text: string }[] };
type Handler = (args: Record<string, unknown>, ctx: unknown) => Promise<Result>;

const toolsOf = (register: (s: McpServer) => void): Record<string, { handler: Handler }> => {
    const server = new McpServer({ name: 'test', version: '0' });
    register(server);
    return (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;
};

const keyed = (port: number, name?: string): KeyedServiceConfig & { name?: string } => ({
    url: `http://192.0.2.10:${port}`,
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false },
    ...(name === undefined ? {} : { name })
});

const down = (async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
}) as unknown as typeof fetch;

describe('a read that could not ask a service says so', () => {
    it('search_media names the unreachable service when nothing came back', async () => {
        const tools = toolsOf(s => registerSearchMedia(s, [new RadarrAdapter(keyed(7878), down)]));
        const result = await tools.search_media!.handler({ query: 'Alien', source: 'library', detail: 'minimal', limit: 50, offset: 0 }, {});
        expect(result.content[0]?.text).toMatch(/^No library results for "Alien"; radarr unreachable\./);
    });

    it('lookup_media names it too', async () => {
        const tools = toolsOf(s => registerLookupMedia(s, [new RadarrAdapter(keyed(7878), down)]));
        const result = await tools.lookup_media!.handler({ query: 'Alien', detail: 'minimal', limit: 50, offset: 0 }, {});
        expect(result.content[0]?.text).toMatch(/^Nothing found for "Alien"; radarr unreachable\./);
    });
});

describe('a read scoped to a service', () => {
    const wanted = (records: unknown[]) => serving({ '/api/v3/wanted/missing': { records, totalRecords: records.length } });

    it('asks every instance of it when none is named', async () => {
        const hd = new RadarrAdapter(keyed(7878, 'hd'), wanted([{ id: 1, title: 'Alien', monitored: true, hasFile: false }]));
        const uhd = new RadarrAdapter(keyed(7879, '4k'), wanted([{ id: 2, title: 'Aliens', monitored: true, hasFile: false }]));
        const result = await buildGetWanted([hd, uhd], { service: 'radarr', scope: 'missing', detail: 'full', limit: 50 });
        expect(result.items.map(i => i.service).sort()).toEqual(['radarr/4k', 'radarr/hd']);
    });

    it('refuses a service that cannot answer, naming every one that can', async () => {
        const jellyfin = {
            id: 'jellyfin',
            type: 'jellyfin',
            getVersion: async () => '10.11.0',
            testConnection: async () => ({ ok: true, service: 'jellyfin', latency_ms: 1 })
        } as unknown as ServiceAdapter;
        await expect(buildGetBlocklist([jellyfin], { service: 'jellyfin', detail: 'full', limit: 50 })).rejects.toThrow(
            /radarr, sonarr, whisparr and lidarr only/
        );
    });
});
