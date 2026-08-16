import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The template is a fourth copy of facts the Dockerfile already states — port,
 * config path, image name — and nothing in a normal change would notice it
 * drifting. An Unraid user finds out by installing a container whose WebUI
 * button opens a closed port.
 *
 * Regex rather than an XML parser: this file is ours, its shape is fixed, and
 * a parser dependency for one test is not worth carrying.
 */
const root = join(import.meta.dirname, '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');

const template = read('unraid/arr-mcp.xml');
const dockerfile = read('Dockerfile');
const compose = read('docker-compose.example.yml');

const config = (name: string): Record<string, string> => {
    const block = new RegExp(`<Config\\b[^>]*\\bName="${name}"[\\s\\S]*?(?:/>|</Config>)`).exec(template)?.[0];
    if (block === undefined) throw new Error(`the template declares no Config named ${name}`);
    return Object.fromEntries([...block.matchAll(/(\w+)="([^"]*)"/g)].map(m => [m[1]!, m[2]!]));
};

describe('the Unraid Community Applications template', () => {
    it('publishes the port the image exposes', () => {
        const exposed = /^EXPOSE (\d+)$/m.exec(dockerfile)?.[1];
        expect(exposed).toBeDefined();
        expect(config('WebUI').Target).toBe(exposed);
        // The WebUI button builds its url from this, so a stale one sends every
        // installer to a closed port.
        expect(template).toContain(`<WebUI>http://[IP]:[PORT:${exposed}]</WebUI>`);
    });

    it('mounts the config directory the image actually writes to', () => {
        const configDir = /ARR_MCP_CONFIG_DIR=(\S+)/.exec(dockerfile)?.[1];
        expect(configDir).toBe('/config');
        expect(config('Appdata').Target).toBe(configDir);
        expect(config('Appdata').Mode).toBe('rw');
    });

    it('installs the image the compose example names', () => {
        const image = /image:\s*(\S+)/.exec(compose)?.[1];
        expect(image).toBeDefined();
        expect(/<Repository>([^<]+)<\/Repository>/.exec(template)?.[1]).toBe(image);
    });

    /**
     * The values deliberately differ from the Dockerfile's 1000:1000: Unraid's
     * appdata share is owned by `nobody:users`, so a container running as 1000
     * cannot write its own config. What must not drift is the variable *names*
     * — the entrypoint is what makes them work at all.
     */
    it('declares the ownership variables the entrypoint honours, at Unraid ids', () => {
        const entrypoint = read('docker-entrypoint.sh');
        for (const name of ['PUID', 'PGID']) {
            expect(config(name).Target).toBe(name);
            expect(entrypoint).toContain(`${name}=\${${name}:-`);
        }
        expect(config('PUID').Default).toBe('99');
        expect(config('PGID').Default).toBe('100');
    });

    it('points its raw URLs at files that exist', () => {
        const raw = [...template.matchAll(/https:\/\/raw\.githubusercontent\.com\/bardesss\/arr-mcp\/main\/(\S+?)</g)].map(
            m => m[1]!
        );
        // Both the icon and the template's own self-reference: a 404 here is a
        // listing with a broken image or an app CA cannot refresh.
        expect(raw).toEqual(expect.arrayContaining(['assets/logo.png', 'unraid/arr-mcp.xml']));
        for (const path of raw) expect(existsSync(join(root, path)), `${path} is referenced but missing`).toBe(true);
    });

    it('carries the fields CA refuses a submission without', () => {
        for (const tag of ['Name', 'Repository', 'Registry', 'Network', 'Support', 'Project', 'Overview', 'Category', 'TemplateURL', 'Icon']) {
            expect(new RegExp(`<${tag}>[^<]*\\S[^<]*</${tag}>`, 's').test(template), `<${tag}> is empty or absent`).toBe(true);
        }
        expect(template).toMatch(/^<\?xml version="1\.0"\?>\s*<Container version="2">/);
    });

    // The setup page is first-come-first-served, so an Unraid user who installs
    // it and walks away has handed the instance to whoever loads it next.
    it('warns that the instance must be claimed', () => {
        expect(template.toLowerCase()).toContain('claim');
    });
});
