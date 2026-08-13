import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.ts';
import { saveConfig } from '../src/config/save.ts';
import { ConfigSchema, ThemeSchema } from '../src/config/schema.ts';
import { CSS } from '../src/web/assets.ts';
import { html, raw } from '../src/web/html.ts';
import { layout } from '../src/web/pages.ts';
import { buildAppearanceConfig } from '../src/web/routes.ts';

const page = (theme?: 'system' | 'dark' | 'light') =>
    layout({ title: 't', version: '1.0.0', body: html`${raw('')}`, theme });

describe('the theme attribute', () => {
    it.each(['dark', 'light'] as const)('stamps %s on the root element', t => {
        expect(page(t)).toContain(`<html lang="en" data-theme="${t}">`);
    });

    // Absent rather than data-theme="system": the CSS falls through to
    // prefers-color-scheme, and an attribute would have to be excluded from
    // both rules by hand.
    it.each([undefined, 'system'] as const)('leaves the attribute off for %s', t => {
        expect(page(t)).toContain('<html lang="en">');
        expect(page(t)).not.toContain('data-theme');
    });
});

describe('the light palette', () => {
    /** The bug this pair of assertions exists for: the light block overrode
     *  seven tokens and left the status colours at their dark values, which put
     *  warn at about 1.8:1 on white. */
    it.each(['--ok', '--warn', '--bad', '--bg', '--text'])('redefines %s for light', token => {
        const light = CSS.slice(CSS.indexOf('prefers-color-scheme: light'));
        expect(light).toContain(token);
    });

    it('applies the same palette to the media query and the attribute', () => {
        // Both selectors interpolate one constant, so the count of any light
        // token is exactly two — one per rule. A token added to only one of
        // them is the failure mode being guarded.
        expect(CSS.match(/--warn: #b45309/g)).toHaveLength(2);
    });
});

describe('buildAppearanceConfig', () => {
    const base = ConfigSchema.parse({
        auth: { bearer_token: 'a'.repeat(64) },
        services: {}
    });

    it.each(['dark', 'light'] as const)('writes %s', t => {
        expect(buildAppearanceConfig(base, { 'ui.theme': t }).ui).toEqual({ theme: t });
    });

    // Same rule as the IMDb card: the default is expressed by the block being
    // absent, so choosing it leaves the file as clean as it started.
    it('drops the block for system rather than writing it out', () => {
        const saved = buildAppearanceConfig({ ...base, ui: { theme: 'dark' } }, { 'ui.theme': 'system' });
        expect(saved.ui).toBeUndefined();
        expect('ui' in saved).toBe(false);
    });

    /** A value the schema would refuse must not reach the file: the next load
     *  parses it, so writing it through turns a bad form post into a server
     *  that will not start. */
    it('falls back to system rather than writing a value the schema refuses', () => {
        expect(buildAppearanceConfig(base, { 'ui.theme': 'solarized' }).ui).toBeUndefined();
        expect(ThemeSchema.safeParse('solarized').success).toBe(false);
    });

    it('leaves everything it does not own alone', () => {
        const withServices = { ...base, metadata: { imdb: { enabled: true } } };
        const saved = buildAppearanceConfig(withServices, { 'ui.theme': 'dark' });
        expect(saved.metadata).toEqual({ imdb: { enabled: true } });
        expect(saved.auth).toEqual(base.auth);
    });
});

/** `saveConfig` writes a hand-picked set of keys, and `ui` was not one of
 *  them — so the card saved nothing and the banner claimed it had. */
describe('the theme through a save', () => {
    const BASE = `auth:\n  bearer_token: ${'f'.repeat(64)}\n  password_hash: scrypt$00$11\nservices: {}\n`;
    const dirWith = async (yaml: string) => {
        const dir = await mkdtemp(join(tmpdir(), 'arr-mcp-theme-'));
        await writeFile(join(dir, 'config.yaml'), yaml, 'utf8');
        return dir;
    };

    it('reaches the file when the card chooses one', async () => {
        const dir = await dirWith(BASE);
        const { config } = await loadConfig(dir);

        await saveConfig(dir, buildAppearanceConfig(config, { 'ui.theme': 'light' }));

        expect((await loadConfig(dir)).config.ui?.theme).toBe('light');
    });

    // `system` is the block being absent, so going back to it has to delete
    // one already on disk — which a write-only fix would miss.
    it('leaves the file with no ui block when the card chooses system', async () => {
        const dir = await dirWith(`${BASE}ui:\n  theme: dark\n`);
        const { config } = await loadConfig(dir);
        expect(config.ui?.theme).toBe('dark');

        await saveConfig(dir, buildAppearanceConfig(config, { 'ui.theme': 'system' }));

        expect((await loadConfig(dir)).config.ui).toBeUndefined();
    });

    it('survives a save that was about something else entirely', async () => {
        const dir = await dirWith(`${BASE}ui:\n  theme: dark\n`);
        const { config } = await loadConfig(dir);

        await saveConfig(dir, config);

        expect((await loadConfig(dir)).config.ui?.theme).toBe('dark');
    });
});

describe('the ui block in config', () => {
    const parse = (ui: unknown) =>
        ConfigSchema.safeParse({ auth: { bearer_token: 'a'.repeat(64) }, services: {}, ui });

    it('defaults theme to system when the block is present but empty', () => {
        expect(parse({}).data?.ui).toEqual({ theme: 'system' });
    });

    it('refuses a theme it does not have a palette for', () => {
        expect(parse({ theme: 'solarized' }).success).toBe(false);
    });

    it('refuses an unknown key rather than silently dropping it', () => {
        expect(parse({ theme: 'dark', accent: '#ff0000' }).success).toBe(false);
    });
});
