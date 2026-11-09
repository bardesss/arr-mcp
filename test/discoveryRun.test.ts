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
                return entries.map(e => ({ type: e.type, url: `http://${host}:${e.port}`, source, version: '5.0' }));
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
        // radarr was seen both ways with the same version, so it is one row
        expect(state.rows.map(r => r.url).sort()).toEqual(['http://nas.lan:7878', 'http://nas.lan:8989']);
        expect(state.rows.find(r => r.type === 'radarr')?.alsoAt).toBe('http://radarr:7878');
        expect(d.current()?.id).toBe(state.id);
    });

    it('keeps two versionless finds at different addresses as two rows', async () => {
        const d = new Discovery({
            catalog,
            lookup,
            probe: async (host, entries, source) => entries.map(e => ({ type: e.type, url: `http://${host}:${e.port}`, source }))
        });
        const state = await d.quick('nas.lan:3000', config);
        expect(state.rows.filter(r => r.type === 'radarr').map(r => r.url).sort()).toEqual(['http://nas.lan:7878', 'http://radarr:7878']);
        expect(state.rows.some(r => r.alsoAt !== undefined)).toBe(false);
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

describe('a run that fails', () => {
    const broken = {
        get services(): never {
            throw new Error('boom');
        }
    } as unknown as Config;
    const okProbe = async (): Promise<Found[]> => [];
    const rejecting = async (): Promise<Found[]> => {
        throw new Error('nope');
    };

    it('quick ends not running when matching throws, and a later run starts', async () => {
        vi.spyOn(logger, 'error').mockImplementation(() => {});
        const d = new Discovery({ catalog, lookup, probe: okProbe });
        const state = await d.quick('nas.lan', broken);
        expect(state.running).toBe(false);
        expect(d.current()?.running).toBe(false);
        expect((await d.quick('nas.lan', config)).id).not.toBe(state.id);
    });

    it('quick ends not running when a probe rejects, and a later run starts', async () => {
        const d = new Discovery({ catalog, lookup, probe: rejecting });
        const state = await d.quick('nas.lan', config);
        expect(state.running).toBe(false);
        expect((await d.quick('nas.lan', config)).id).not.toBe(state.id);
    });

    it('sweep ends not running when the probe rejects, and a later sweep starts', async () => {
        const d = new Discovery({ catalog, lookup, probe: rejecting });
        const a = d.startSweep('192.168.1.0/30', config);
        await vi.waitFor(() => expect(d.current()?.running).toBe(false));
        expect(d.current()?.tried).toBe(4);
        const b = d.startSweep('192.168.1.0/30', config);
        if ('refused' in a || 'refused' in b) throw new Error('refused');
        expect(b.id).not.toBe(a.id);
        await vi.waitFor(() => expect(d.current()?.running).toBe(false));
    });

    it('sweep ends not running, with no unhandled rejection, when the logger throws', async () => {
        const unhandled = vi.fn();
        process.on('unhandledRejection', unhandled);
        vi.spyOn(logger, 'info').mockImplementation(() => {
            throw new Error('log down');
        });
        const d = new Discovery({ catalog, lookup, probe: okProbe });
        d.startSweep('192.168.1.0/30', config);
        await vi.waitFor(() => expect(d.current()?.running).toBe(false));
        await flush();
        process.off('unhandledRejection', unhandled);
        expect(unhandled).not.toHaveBeenCalled();
    });

    it('sweep survives a throw while matching its rows', async () => {
        const d = new Discovery({
            catalog,
            lookup,
            probe: async (host, _e, source) => [{ type: 'radarr', url: `http://${host}:7878`, source }]
        });
        d.startSweep('192.168.1.0/30', broken);
        await vi.waitFor(() => expect(d.current()?.running).toBe(false));
        expect(d.current()?.tried).toBe(4);
    });
});

describe('quick while quick runs', () => {
    it('returns the same run and probes nothing more', async () => {
        let release!: () => void;
        const gate = new Promise<void>(resolve => (release = resolve));
        let calls = 0;
        const d = new Discovery({
            catalog,
            lookup,
            probe: async () => {
                calls += 1;
                await gate;
                return [];
            }
        });
        const first = d.quick('nas.lan', config);
        await flush();
        const callsBefore = calls;
        const second = await d.quick('nas.lan', config);
        expect(second.running).toBe(true);
        expect(second.id).toBe(d.current()?.id);
        expect(calls).toBe(callsBefore);
        release();
        expect((await first).id).toBe(second.id);
    });
});

describe('matching against the config as it is now', () => {
    it('view rematches the run against the config it is given', async () => {
        const d = new Discovery({
            catalog,
            lookup,
            probe: async (host, entries, source) => entries.map(e => ({ type: e.type, url: `http://${host}:${e.port}`, source }))
        });
        await d.quick('192.168.1.10', config);
        expect((await d.view(config))?.rows.find(r => r.type === 'radarr')?.status).toBe('new');
        const after = ConfigSchema.parse({
            auth: AUTH,
            services: { radarr: { url: 'http://192.168.1.10:7878', api_key: 'k', permissions: {} } }
        });
        expect((await d.view(after))?.rows.find(r => r.type === 'radarr')?.status).toBe('added');
    });

    it('view gives nothing before a run', async () => {
        expect(await new Discovery({ catalog, lookup, probe: async () => [] }).view(config)).toBeUndefined();
    });
});

describe('what a quick search says it tried', () => {
    it('names the host and counts the container names that resolved', async () => {
        const d = new Discovery({ catalog, lookup, probe: async () => [] });
        const state = await d.quick('nas.lan:6060', config);
        expect(state.hostTried).toBe('nas.lan');
        expect(state.hostAddress).toBe('192.168.1.10');
        // radarr resolves privately; sonarr resolves to a public address and is not counted
        expect(state.containersResolved).toBe(1);
        expect(state.failed).toBeUndefined();
    });

    it('leaves the host out when it was skipped', async () => {
        const d = new Discovery({ catalog, lookup, probe: async () => [] });
        const state = await d.quick('localhost:6060', config);
        expect(state.hostTried).toBeUndefined();
    });

    it('flags a quick search that threw', async () => {
        vi.spyOn(logger, 'error').mockImplementation(() => {});
        const broken = {
            get services(): never {
                throw new Error('boom');
            }
        } as unknown as Config;
        const d = new Discovery({ catalog, lookup, probe: async () => [] });
        const state = await d.quick('nas.lan', broken);
        expect(state.failed).toBe(true);
    });

    it('suggests the range of the private IPv4 when the host also has a public IPv6', async () => {
        const d = new Discovery({
            catalog,
            lookup: async host => (host === 'fritz.box' ? ['2a02:8109:1234::1', '192.168.178.1'] : Promise.reject(new Error('ENOTFOUND'))),
            probe: async () => []
        });
        const state = await d.quick('fritz.box', config);
        expect(state.hostAddress).toBe('192.168.178.1');
        expect(state.suggestedRange).toBe('192.168.178.0/24');
    });
});

describe('slow lookups', () => {
    it('finishes a quick search when a container lookup never settles, and drops that name', async () => {
        const calls: string[] = [];
        const d = new Discovery({
            catalog,
            lookup: host => (host === 'radarr' ? new Promise<string[]>(() => {}) : lookup(host)),
            lookupTimeoutMs: 20,
            probe: async host => {
                calls.push(host);
                return [];
            }
        });
        const state = await d.quick('192.168.1.10', config);
        expect(state.running).toBe(false);
        expect(calls).not.toContain('radarr');
        expect(calls).toContain('192.168.1.10');
    });

    it('finishes in a few seconds with the defaults when no container name resolves and each lookup is slow to fail', async () => {
        const many = Array.from({ length: 22 }, (_, i) => entry('radarr', 7878, [`name${i}`]));
        const d = new Discovery({ catalog: many, lookup: () => new Promise<string[]>((_, reject) => setTimeout(() => reject(new Error('ENOTFOUND')), 200)), probe: async () => [] });
        const started = Date.now();
        const state = await d.quick('192.168.1.10', config);
        expect(state.running).toBe(false);
        expect(state.containersResolved).toBe(0);
        expect(Date.now() - started).toBeLessThan(3000);
    });
});

describe('timeouts', () => {
    it('gives a quick probe 3000 ms and a sweep probe 800 ms', async () => {
        const seen: { source: Found['source']; timeoutMs: number }[] = [];
        const d = new Discovery({
            catalog,
            lookup,
            probe: async (_h, _e, source, opts) => {
                seen.push({ source, timeoutMs: opts.timeoutMs });
                return [];
            }
        });
        await d.quick('192.168.1.10', config);
        d.startSweep('192.168.1.0/30', config);
        await vi.waitFor(() => expect(d.current()?.running).toBe(false));
        expect(seen.filter(s => s.source !== 'sweep').every(s => s.timeoutMs === 3000)).toBe(true);
        expect(seen.filter(s => s.source === 'sweep').map(s => s.timeoutMs)).toEqual([800, 800, 800, 800]);
    });
});

describe('a sweep after a quick search', () => {
    it("keeps the quick search's rows, including one found only by container name", async () => {
        const d = new Discovery({
            catalog,
            lookup,
            probe: async (host, entries, source) => {
                if (source === 'container') return entries.map(e => ({ type: e.type, url: `http://${host}:${e.port}`, source }));
                if (source === 'sweep' && host === '192.168.1.2') return [{ type: 'sonarr', url: `http://${host}:8989`, source }];
                return [];
            }
        });
        await d.quick('192.168.1.10', config);
        expect(d.current()?.rows.map(r => r.url)).toEqual(['http://radarr:7878']);
        d.startSweep('192.168.1.0/30', config);
        expect(d.current()?.rows.map(r => r.url)).toEqual(['http://radarr:7878']);
        await vi.waitFor(() => expect(d.current()?.running).toBe(false));
        expect(d.current()?.rows.map(r => r.url).sort()).toEqual(['http://192.168.1.2:8989', 'http://radarr:7878']);
        expect((await d.view(config))?.rows.map(r => r.url).sort()).toEqual(['http://192.168.1.2:8989', 'http://radarr:7878']);
    });

    it('does not list an address twice when the sweep finds what the quick search found', async () => {
        const d = new Discovery({
            catalog,
            lookup,
            probe: async (host, entries, source) =>
                host === '192.168.1.1' ? entries.map(e => ({ type: e.type, url: `http://${host}:${e.port}`, source })) : []
        });
        await d.quick('192.168.1.1', config);
        d.startSweep('192.168.1.0/30', config);
        await vi.waitFor(() => expect(d.current()?.running).toBe(false));
        expect(d.current()?.rows.map(r => r.url).sort()).toEqual(['http://192.168.1.1:7878', 'http://192.168.1.1:8989']);
    });
});

describe('lookup concurrency', () => {
    it('resolves at most three container names at once', async () => {
        const names = ['a', 'b', 'c', 'd', 'e', 'f'];
        const many = names.map((n, i) => entry('radarr', 7000 + i, [n]));
        let now = 0;
        let max = 0;
        const counting = async (): Promise<string[]> => {
            now += 1;
            max = Math.max(max, now);
            await new Promise(r => setTimeout(r, 10));
            now -= 1;
            throw new Error('ENOTFOUND');
        };
        await new Discovery({ catalog: many, lookup: counting, probe: async () => [] }).quick(undefined, config);
        expect(max).toBe(3);
    });

    it('finishes in bounded time when no lookup ever settles', async () => {
        const many = Array.from({ length: 10 }, (_, i) => entry('radarr', 7878, [`name${i}`]));
        const d = new Discovery({
            catalog: many,
            lookup: () => new Promise<string[]>(() => {}),
            lookupTimeoutMs: 20,
            lookupQueueTimeoutMs: 60,
            probe: async () => []
        });
        const state = await d.quick('192.168.1.10', config);
        expect(state.running).toBe(false);
        expect(state.containersResolved).toBe(0);
    }, 2000);
});
