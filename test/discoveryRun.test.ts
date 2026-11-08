import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema, type Config } from '../src/config/schema.ts';
import { logger } from '../src/core/logger.ts';
import type { CatalogEntry } from '../src/discovery/catalog.ts';
import { Discovery } from '../src/discovery/run.ts';
import type { Found, ProbeOpts } from '../src/discovery/probe.ts';

const AUTH = { bearer_token: 'a'.repeat(64), username: 'admin', allowed_hosts: [] };
const config: Config = ConfigSchema.parse({ auth: AUTH, services: {} });

const entry = (type: CatalogEntry['type'], port: number, names: string[] = []): CatalogEntry => ({
    type,
    port,
    containerNames: names,
    path: '/',
    identify: () => ({})
});
const catalog = [entry('radarr', 7878, ['radarr']), entry('sonarr', 8989, ['sonarr'])];

const lookup = async (host: string): Promise<string[]> => {
    if (host === 'radarr') return ['172.18.0.5'];
    if (host === 'sonarr') return ['8.8.8.8'];
    if (host === 'nas.lan') return ['192.168.1.10'];
    if (host === 'localhost') return ['127.0.0.1'];
    throw new Error('ENOTFOUND');
};

type Call = { host: string; entries: readonly CatalogEntry[]; source: Found['source']; opts: ProbeOpts };

beforeEach(() => {
    vi.spyOn(logger, 'info').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('quick', () => {
    it('probes the request host and each container name that resolves privately', async () => {
        const calls: Call[] = [];
        const d = new Discovery({
            catalog,
            lookup,
            probe: async (host, entries, source, opts) => {
                calls.push({ host, entries, source, opts });
                return entries.map(e => ({ type: e.type, url: `http://${host}:${e.port}`, source }));
            }
        });
        const state = await d.quick('nas.lan:3000', config);
        expect(state.running).toBe(false);
        expect(state.phase).toBe('quick');
        expect(state.suggestedRange).toBe('192.168.1.0/24');
        const hostCall = calls.find(c => c.source === 'host');
        expect(hostCall?.opts.address).toBe('192.168.1.10');
        expect(hostCall?.entries).toHaveLength(2);
        // sonarr resolves to a public address and is dropped without a trace
        const containers = calls.filter(c => c.source === 'container');
        expect(containers.map(c => c.host)).toEqual(['radarr']);
        expect(containers[0]?.entries.map(e => e.type)).toEqual(['radarr']);
        expect(containers[0]?.opts.address).toBe('172.18.0.5');
        expect(state.skipped).toEqual([]);
        // radarr was seen both ways with the same (absent) version, so it is one row
        expect(state.rows.map(r => r.url).sort()).toEqual(['http://nas.lan:7878', 'http://nas.lan:8989']);
        expect(state.rows.find(r => r.type === 'radarr')?.alsoAt).toBe('http://radarr:7878');
        expect(d.current()?.id).toBe(state.id);
    });

    it('records a refused request host with its reason', async () => {
        const d = new Discovery({ catalog, lookup, probe: async () => [] });
        const state = await d.quick('example.com', config);
        expect(state.skipped).toHaveLength(1);
        expect(state.skipped[0]).toMatchObject({ what: 'example.com' });
        expect(state.skipped[0]?.reason).toContain('example.com does not resolve');
        expect(state.suggestedRange).toBeUndefined();
    });

    it('skips localhost as the host, still runs the containers, and suggests no range', async () => {
        const calls: Call[] = [];
        const d = new Discovery({
            catalog,
            lookup,
            probe: async (host, entries, source, opts) => {
                calls.push({ host, entries, source, opts });
                return [];
            }
        });
        const state = await d.quick('localhost:3000', config);
        expect(calls.some(c => c.source === 'host')).toBe(false);
        expect(calls.some(c => c.source === 'container')).toBe(true);
        expect(state.suggestedRange).toBeUndefined();
        expect(state.skipped.map(s => s.what)).toEqual(['localhost']);
    });
});

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

describe('sweep', () => {
    it('starts at once, advances, and finishes', async () => {
        const d = new Discovery({ catalog, lookup, probe: async () => [], concurrency: 4 });
        const first = d.startSweep('192.168.1.0/24', config);
        if ('refused' in first) throw new Error(first.refused);
        expect(first).toMatchObject({ running: true, total: 256, phase: 'sweep', range: '192.168.1.0/24' });
        await vi.waitFor(() => expect(d.current()?.running).toBe(false));
        expect(d.current()).toMatchObject({ tried: 256, total: 256 });
    });

    it('shows rows while the sweep is still running', async () => {
        let release!: () => void;
        const gate = new Promise<void>(resolve => (release = resolve));
        const d = new Discovery({
            catalog,
            lookup,
            concurrency: 4,
            probe: async (host, entries, source) => {
                if (host === '192.168.1.200') await gate;
                if (host === '192.168.1.5') return [{ type: 'radarr', url: `http://${host}:7878`, source }];
                return [];
            }
        });
        d.startSweep('192.168.1.0/24', config);
        await vi.waitFor(() => expect(d.current()?.rows).toHaveLength(1));
        expect(d.current()?.running).toBe(true);
        expect(d.current()?.rows[0]).toMatchObject({ url: 'http://192.168.1.5:7878', status: 'new' });
        release();
        await vi.waitFor(() => expect(d.current()?.running).toBe(false));
    });

    it('returns the running sweep for a second start and for quick, probing nothing extra', async () => {
        let release!: () => void;
        const gate = new Promise<void>(resolve => (release = resolve));
        let calls = 0;
        const d = new Discovery({
            catalog,
            lookup,
            concurrency: 2,
            probe: async () => {
                calls += 1;
                await gate;
                return [];
            }
        });
        const a = d.startSweep('192.168.1.0/24', config);
        await flush();
        const callsBefore = calls;
        const b = d.startSweep('192.168.1.0/24', config);
        const q = await d.quick('nas.lan', config);
        if ('refused' in a || 'refused' in b) throw new Error('refused');
        expect(b.id).toBe(a.id);
        expect(q.id).toBe(a.id);
        expect(q.phase).toBe('sweep');
        await flush();
        expect(calls).toBe(callsBefore);
        release();
        await vi.waitFor(() => expect(d.current()?.running).toBe(false));
    });

    it('refuses a public range with the reason from the range check', async () => {
        const d = new Discovery({ catalog, lookup, probe: async () => [] });
        const out = d.startSweep('8.8.8.0/24', config);
        expect(out).toEqual({ refused: '8.8.8.0 is not a private address' });
        expect(d.current()).toBeUndefined();
    });

    it('never has more than the concurrency cap in flight', async () => {
        let inFlight = 0;
        let peak = 0;
        const d = new Discovery({
            catalog,
            lookup,
            concurrency: 5,
            probe: async () => {
                inFlight += 1;
                peak = Math.max(peak, inFlight);
                await flush();
                inFlight -= 1;
                return [];
            }
        });
        d.startSweep('192.168.1.0/24', config);
        await vi.waitFor(() => expect(d.current()?.running).toBe(false));
        expect(peak).toBe(5);
    });

    it('matches rows against the config given to startSweep', async () => {
        const cfg = ConfigSchema.parse({
            auth: AUTH,
            services: { radarr: { url: 'http://192.168.1.5:7878', api_key: 'k', permissions: {} } }
        });
        const d = new Discovery({
            catalog,
            lookup,
            probe: async (host, _e, source) => (host === '192.168.1.5' ? [{ type: 'radarr', url: `http://${host}:7878`, source }] : [])
        });
        d.startSweep('192.168.1.0/24', cfg);
        await vi.waitFor(() => expect(d.current()?.running).toBe(false));
        expect(d.current()?.rows[0]?.status).toBe('added');
    });
});

describe('logging', () => {
    it('writes one info line per run naming its sources and range', async () => {
        const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
        const d = new Discovery({ catalog, lookup, probe: async () => [] });
        await d.quick('nas.lan', config);
        expect(info).toHaveBeenCalledTimes(1);
        expect(info.mock.calls[0]?.[0]).toMatchObject({ sources: ['host nas.lan', 'containers'], rows: 0 });

        info.mockClear();
        d.startSweep('192.168.1.0/30', config);
        await vi.waitFor(() => expect(d.current()?.running).toBe(false));
        expect(info).toHaveBeenCalledTimes(1);
        expect(info.mock.calls[0]?.[0]).toMatchObject({ sources: ['sweep'], range: '192.168.1.0/30', rows: 0 });
    });
});
