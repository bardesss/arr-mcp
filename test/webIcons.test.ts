import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ServiceIdSchema } from '../src/config/schema.ts';
import { ICONS, LOGO, MARK_SVG, serviceIcon } from '../src/web/icons.ts';

describe('the service icon set', () => {
    // The point of the test: adding a service to the schema without drawing it
    // an icon should fail here rather than ship a card with a hole in it.
    it.each(ServiceIdSchema.options)('has an icon for %s', id => {
        expect(ICONS[id]).toMatch(/^<svg/);
    });

    it('has no icon for a service the schema does not define', () => {
        const known = new Set<string>(ServiceIdSchema.options);
        expect(Object.keys(ICONS).filter(id => !known.has(id))).toEqual([]);
    });

    /** They are drawn to inherit the card's colour, which is what makes one set
     *  work on both themes without a light and a dark variant of each. */
    it.each(ServiceIdSchema.options)('draws %s in currentColor only', id => {
        const svg = ICONS[id] ?? '';
        expect(svg).toContain('currentColor');
        expect(svg).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    });

    // The service name sits next to the icon, so announcing it would read the
    // same word twice.
    it.each(ServiceIdSchema.options)('hides %s from assistive tech', id => {
        expect(ICONS[id]).toContain('aria-hidden="true"');
    });
});

describe('the project mark', () => {
    it('inherits colour like the service marks, so one drawing serves both themes', () => {
        expect(LOGO).toContain('currentColor');
        expect(LOGO).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    });

    // A favicon and an <img> have nothing to inherit from, so this one must not.
    it('carries a literal colour in the standalone variant', () => {
        expect(MARK_SVG).toMatch(/#[0-9a-f]{6}\b/i);
        expect(MARK_SVG).toContain('xmlns=');
    });

    // README and Unraid read the committed file; the config UI serves the
    // constant. Regenerate with `npm run icon:write` if this fails.
    it('matches the committed assets/logo.svg byte for byte', () => {
        const committed = readFileSync(join(import.meta.dirname, '..', 'assets/logo.svg'), 'utf8');
        expect(committed).toBe(MARK_SVG);
    });
});

describe('serviceIcon', () => {
    it('resolves a qualified instance id to its service icon', () => {
        expect(serviceIcon('radarr/4k').value).toBe(serviceIcon('radarr').value);
    });

    it('falls back to a generic mark rather than a gap', () => {
        const fallback = serviceIcon('something-else-entirely');
        expect(fallback.value).toMatch(/^<svg/);
        expect(Object.values(ICONS)).not.toContain(fallback.value);
    });

    it('does not let an instance name smuggle markup into the page', () => {
        expect(serviceIcon('<img src=x onerror=alert(1)>').value).not.toContain('<img');
    });
});
