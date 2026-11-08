import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ServiceIdSchema, type ServiceId } from '../src/config/schema.ts';
import { CATALOG, UNDISCOVERABLE, type CatalogEntry, type ProbeResponse } from '../src/discovery/catalog.ts';

type Fixture = ProbeResponse & { service: ServiceId; path: string; source: 'live' | 'docs'; version?: string };

const DIR = new URL('./fixtures/discovery/', import.meta.url);
const fixtures: { name: string; fixture: Fixture }[] = readdirSync(DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(name => ({ name, fixture: JSON.parse(readFileSync(new URL(name, DIR), 'utf8')) as Fixture }));

const respond = (f: Fixture): ProbeResponse => ({ status: f.status, headers: f.headers, body: f.body });
const matches = (r: ProbeResponse): CatalogEntry[] => CATALOG.filter(e => e.identify(r) !== undefined);
const entry = (type: ServiceId): CatalogEntry => {
    const e = CATALOG.find(c => c.type === type);
    if (!e) throw new Error(`no catalog entry for ${type}`);
    return e;
};

describe('discovery catalog', () => {
    it('has a fixture marked live or docs for every catalog service', () => {
        const covered = new Set(fixtures.map(f => f.fixture.service));
        for (const e of CATALOG) expect(covered.has(e.type), e.type).toBe(true);
        for (const { name, fixture } of fixtures) expect(['live', 'docs'], name).toContain(fixture.source);
    });

    it('identifies each captured fixture as its own service', () => {
        for (const { name, fixture } of fixtures) {
            const hits = matches(respond(fixture));
            expect(hits.map(h => h.type), name).toEqual([fixture.service]);
            const found = entry(fixture.service).identify(respond(fixture));
            expect(found?.version, name).toBe(fixture.version);
        }
    });

    it("no entry claims another service's response", () => {
        for (const { name, fixture } of fixtures) {
            for (const e of CATALOG) {
                if (e.type === fixture.service) continue;
                expect(e.identify(respond(fixture)), `${e.type} on ${name}`).toBeUndefined();
            }
        }
    });

    it("each fixture was captured from its own entry's path", () => {
        for (const { name, fixture } of fixtures) expect(fixture.path, name).toBe(entry(fixture.service).path);
    });

    it('sabnzbd and qbittorrent share 8080 and are told apart', () => {
        const sab = entry('sabnzbd');
        const qb = entry('qbittorrent');
        expect(sab.port).toBe(8080);
        expect(qb.port).toBe(8080);
        for (const { name, fixture } of fixtures) {
            const r = respond(fixture);
            expect(sab.identify(r) !== undefined, `sabnzbd on ${name}`).toBe(fixture.service === 'sabnzbd');
            expect(qb.identify(r) !== undefined, `qbittorrent on ${name}`).toBe(fixture.service === 'qbittorrent');
        }
    });

    it('an *arr behind forms login is still named', () => {
        const radarr = fixtures.find(f => f.name === 'radarr-login.json');
        expect(radarr).toBeDefined();
        const r = respond(radarr!.fixture);
        expect(matches(r).map(e => e.type)).toEqual(['radarr']);
        expect(entry('sonarr').identify(r)).toBeUndefined();
    });

    it('does not name a response that only looks like a service', () => {
        const cases: ProbeResponse[] = [
            { status: 200, headers: {}, body: '<html>hello</html>' },
            { status: 200, headers: { 'content-type': 'text/html' }, body: '<title>Login - Nginx</title>' },
            { status: 404, headers: {}, body: '<title>Radarr</title>' },
            { status: 200, headers: {}, body: '{"version":3}' },
            { status: 409, headers: {}, body: 'Conflict' },
            { status: 401, headers: { 'www-authenticate': 'Basic realm="Router"' }, body: '' },
            { status: 200, headers: {}, body: '' },
            { status: 200, headers: {}, body: 'not json at all {' }
        ];
        for (const r of cases) expect(matches(r).map(e => e.type), JSON.stringify(r)).toEqual([]);
    });

    it('never throws on a malformed body', () => {
        for (const e of CATALOG) {
            for (const body of ['', '{', 'null', '[]', '"x"', '<', '{"data":null}']) {
                expect(() => e.identify({ status: 200, headers: {}, body })).not.toThrow();
            }
        }
    });

    it('uses valid, plausible ports and absolute paths, with container names', () => {
        for (const e of CATALOG) {
            expect(Number.isInteger(e.port) && e.port > 0 && e.port < 65536, e.type).toBe(true);
            expect(e.path.startsWith('/'), e.type).toBe(true);
            expect(e.containerNames.length, e.type).toBeGreaterThan(0);
            for (const n of e.containerNames) expect(n, e.type).toMatch(/^[a-z0-9][a-z0-9_.-]*$/);
        }
    });

    it("no default port is 6060 unless the entry says arr-mcp skips its own port", () => {
        for (const e of CATALOG) {
            if (e.port !== 6060) continue;
            expect(e.note, e.type).toMatch(/arr-mcp/);
            expect(e.note, e.type).toMatch(/skip/i);
        }
    });

    it('every ServiceId is in CATALOG or UNDISCOVERABLE, never both', () => {
        const inCatalog = CATALOG.map(e => e.type);
        const left = UNDISCOVERABLE.map(u => u.type);
        expect(new Set(inCatalog).size).toBe(inCatalog.length);
        for (const id of ServiceIdSchema.options) {
            expect(inCatalog.includes(id) !== left.includes(id), id).toBe(true);
        }
        for (const u of UNDISCOVERABLE) expect(u.reason.length, u.type).toBeGreaterThan(10);
    });
});
