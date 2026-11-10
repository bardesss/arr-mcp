import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Whisparr reads logs, history, download traces and running commands through
 * Sonarr's helpers without a Whisparr capture. That is only allowed while the
 * two specs agree on everything those helpers read; when they stop agreeing,
 * re-capture Whisparr or unclaim the capability.
 */
type Schema = { properties?: Record<string, { type?: string; $ref?: string; items?: unknown }>; enum?: unknown[] };
type Spec = { paths: Record<string, Record<string, unknown>>; components: { schemas: Record<string, Schema> } };

const load = (name: string): Spec => JSON.parse(readFileSync(new URL(`../specs/${name}.json`, import.meta.url), 'utf8')) as Spec;
const sonarr = load('sonarr');
const whisparr = load('whisparr');
/**
 * Swashbuckle documents a .NET TimeSpan as an object in Whisparr's spec and as a
 * "date-span" string in Sonarr's; it is one JSON string either way, and no
 * Sonarr helper reads `duration`.
 */
const SPEC_ARTEFACTS = new Set(['CommandResource.duration']);
const FIX = 're-capture Whisparr or unclaim the capability';

describe('Whisparr inherits Sonarr helpers only while the specs agree', () => {
    it.each(['LogResource', 'LogResourcePagingResource', 'HistoryResource', 'HistoryResourcePagingResource', 'CommandResource'])(
        "%s matches Sonarr's, so Whisparr inherits its helper",
        name => {
            const a = sonarr.components.schemas[name]?.properties ?? {};
            const b = whisparr.components.schemas[name]?.properties ?? {};
            expect(Object.keys(b).sort(), `${name} has different fields: ${FIX}`).toEqual(Object.keys(a).sort());
            for (const key of Object.keys(a).filter(k => !SPEC_ARTEFACTS.has(`${name}.${k}`))) {
                const shape = (p: (typeof a)[string]) => ({ type: p.type, $ref: p.$ref });
                expect(shape(b[key]!), `${name}.${key} changed: ${FIX}`).toEqual(shape(a[key]!));
            }
        }
    );

    it("EpisodeHistoryEventType has Sonarr's values", () => {
        const values = (s: Spec) => s.components.schemas['EpisodeHistoryEventType']?.enum;
        expect(values(whisparr), `event types differ: ${FIX}`).toEqual(values(sonarr));
        expect(values(sonarr)?.length).toBeGreaterThan(0);
    });

    it.each(['/api/v3/log', '/api/v3/history', '/api/v3/history/since', '/api/v3/command'])('%s is a GET in both specs', path => {
        expect(sonarr.paths[path]?.['get'], `Sonarr lost ${path}`).toBeDefined();
        expect(whisparr.paths[path]?.['get'], `Whisparr has no GET ${path}: ${FIX}`).toBeDefined();
    });
});
