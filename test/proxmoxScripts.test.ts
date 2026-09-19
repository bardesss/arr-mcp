import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Proxmox LXC installer is three files that restate decisions made
 * elsewhere in this repository: the port the server binds, the directory it
 * writes to, the Node major the image runs, the file the process starts. None
 * of it is imported, none of it is executed by CI, and a rename one directory
 * over leaves every one of those restatements pointing at nothing.
 *
 * Nobody here would notice. The scripts run on someone else's Proxmox host,
 * days later, and the first symptom is a container that boots onto a closed
 * port or dies at startup on a directory that was never created.
 *
 * So this asserts each restatement against the thing it restates. It cannot
 * say the scripts work — that needs a real PVE host and is tracked separately.
 */
const root = join(import.meta.dirname, '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');

/** Only the fields asserted below; the catalogue schema is upstream's, not ours. */
interface Catalogue {
    interface_port: number;
    updateable: boolean;
    logo: string;
    architectures?: string[];
    install_methods: {
        config_path: string;
        resources: { cpu: number; ram: number; hdd: number; os: string; version: string };
    }[];
}

const ct = read('proxmox/ct/arr-mcp.sh');
const install = read('proxmox/install/arr-mcp-install.sh');
const json = JSON.parse(read('proxmox/json/arr-mcp.json')) as Catalogue;
const pkg = JSON.parse(read('package.json')) as {
    engines: { node: string };
    dependencies: Record<string, string | undefined>;
    devDependencies: Record<string, string | undefined>;
};
const dockerfile = read('Dockerfile');
const entry = read('src/index.ts');
const readme = read('README.md');

/** CLEAN_INSTALL=1 fetch_and_deploy_gh_release empties this on every update. */
const DEPLOY_DIR = '/opt/arr-mcp';
const VERSION_FILE = '/opt/arr-mcp.env';

/** The unit's `Environment=NAME=value` lines. */
const unitEnv = (name: string): string | undefined => new RegExp(`^Environment=${name}=(\\S+)$`, 'm').exec(install)?.[1];

/** `process.env.X ?? default` in src/index.ts — what a container gets when nothing sets X. */
const serverDefault = (name: string): string | undefined =>
    new RegExp(`process\\.env\\.${name} \\?\\? '?([^')\\s]+)'?`).exec(entry)?.[1];

const nodeMajorIn = (script: string): string | undefined => /NODE_VERSION="(\d+)"/.exec(script)?.[1];

describe('the Proxmox LXC installer', () => {
    // Without this, every assertion below would pass just as happily against
    // the empty string a renamed directory hands it.
    it.each([
        ['ct/arr-mcp.sh', ct],
        ['install/arr-mcp-install.sh', install],
    ])('has %s to read, so the assertions below are not passing over nothing', (_name, script) => {
        expect(script).toContain('arr-mcp');
        expect(script.split('\n').length).toBeGreaterThan(20);
    });

    it('points the engine at a base that serves ct/ and install/ from this repo', () => {
        // The most load-bearing line in the three files. The Community Scripts
        // engine fetches install/<app>-install.sh, and bakes /usr/bin/update,
        // out of COMMUNITY_SCRIPTS_URL, which it defaults to their own
        // repository — and theirs does not carry either file. Left unset, the
        // install dies on "Could not fetch install/arr-mcp-install.sh" before a
        // container exists: a total failure on a real host that nothing else
        // here would see.
        const base = /^export COMMUNITY_SCRIPTS_URL="\$\{COMMUNITY_SCRIPTS_URL:-(\S+)\}"$/m.exec(ct)?.[1];
        // Before the source line, because build.func is where that default is
        // applied. Setting it afterwards is setting it too late.
        expect(ct.indexOf('export COMMUNITY_SCRIPTS_URL=')).toBeLessThan(ct.indexOf('core/build.func'));

        const dir = /^https:\/\/raw\.githubusercontent\.com\/bardesss\/arr-mcp\/main\/(\S+)$/.exec(base ?? '')?.[1];
        expect(dir, `${base} is not a raw base under this repository`).toBeDefined();
        // Whatever it points at has to hold the upstream layout, or every fetch
        // 404s one directory away from the files.
        for (const rel of ['ct/arr-mcp.sh', 'install/arr-mcp-install.sh', 'json/arr-mcp.json']) {
            expect(existsSync(join(root, dir!, rel)), `the engine will fetch ${dir}/${rel}`).toBe(true);
        }
    });

    it('gives the README a command that fetches a script that exists', () => {
        const url = /https:\/\/raw\.githubusercontent\.com\/bardesss\/arr-mcp\/main\/(\S+?\.sh)/.exec(readme)?.[1];

        expect(url).toBeDefined();
        expect(existsSync(join(root, url!)), `the README curls ${url}, which is missing`).toBe(true);
    });

    it('sends people to the port the server actually binds', () => {
        // Four copies: the unit's environment, the line the install prints on
        // the host, the field the catalogue renders, and the image's own ENV.
        // Only the first has any effect; the rest are only ever right by
        // agreeing with it.
        const port = unitEnv('ARR_MCP_PORT');

        expect(port).toBeDefined();
        expect(port).toBe(serverDefault('ARR_MCP_PORT'));
        expect(port).toBe(/ARR_MCP_PORT=(\d+)/.exec(dockerfile)?.[1]);
        expect(ct).toContain(`http://\${IP}:${port}`);
        expect(String(json.interface_port)).toBe(port);
    });

    it('writes to the directory the image writes to, and creates it first', () => {
        const configDir = unitEnv('ARR_MCP_CONFIG_DIR');

        expect(configDir).toBe(/ARR_MCP_CONFIG_DIR=(\S+)/.exec(dockerfile)?.[1]);
        expect(configDir).toBe(serverDefault('ARR_MCP_CONFIG_DIR'));
        // LogStore and WriteAudit open SQLite files in here as the first thing
        // index.ts does — before the config loader that would have created it.
        // Absent, that is SQLITE_CANTOPEN at startup, which the Docker
        // entrypoint avoids by creating the directory; so must this.
        expect(install).toContain(`mkdir -p ${configDir}`);
        expect(json.install_methods[0]!.config_path.startsWith(`${configDir}/`)).toBe(true);
    });

    it('keeps everything that must survive an update out of the tree an update deletes', () => {
        // The trailing slash is the whole point. /opt/arr-mcp.env starts with
        // /opt/arr-mcp and is perfectly safe; /opt/arr-mcp/config would also
        // start with it and would be a bearer token deleted on first update.
        for (const path of [unitEnv('ARR_MCP_CONFIG_DIR'), VERSION_FILE]) {
            expect(path).toBeDefined();
            expect(path).not.toBe(DEPLOY_DIR);
            expect(path?.startsWith(`${DEPLOY_DIR}/`)).toBe(false);
        }
    });

    it('installs the Node major the shipped image runs', () => {
        // engines is a floor; the Dockerfile is the runtime a release was
        // actually tested on, which is the stronger claim of the two.
        //
        // The tag suffix is matched loosely on purpose: what the LXC has to
        // agree with is the major, not the base distribution. Pinning the
        // suffix here would read `undefined` the moment that base moved — and
        // `undefined` is exactly what this assertion exists to catch.
        const image = /^FROM node:(\d+)-[a-z0-9.]+/m.exec(dockerfile)?.[1];
        const floor = Number(/(\d+)/.exec(pkg.engines.node)?.[1]);

        expect(image).toBeDefined();
        expect(nodeMajorIn(install)).toBe(image);
        expect(nodeMajorIn(ct)).toBe(image);
        expect(Number(image)).toBeGreaterThanOrEqual(floor);
    });

    it('starts the file the image starts', () => {
        // tsc emits under dist/src because rootDir is the repo root. A change
        // to outDir or rootDir moves this, and nothing else would notice.
        const cmd = /^CMD \["node", "([^"]+)"\]/m.exec(dockerfile)?.[1];

        expect(cmd).toBeDefined();
        expect(install).toContain(`ExecStart=/usr/bin/node ${DEPLOY_DIR}/${cmd}`);
    });

    it('reports the version of the release that is actually deployed', () => {
        // Pinning a literal into the unit would be correct for exactly one
        // release. Both scripts derive it from the deployed package.json
        // instead, so the only way this goes stale is if one of them stops
        // writing it — which is what the pair of assertions below is for.
        const write = `echo "ARR_MCP_VERSION=$(node -p "require('${DEPLOY_DIR}/package.json').version")" >${VERSION_FILE}`;

        expect(install).toContain(write);
        expect(ct).toContain(write);
        expect(install).toContain(`EnvironmentFile=-${VERSION_FILE}`);
        // If the server stopped reading it, the unit would be feeding an
        // environment variable nothing consumes.
        expect(serverDefault('ARR_MCP_VERSION')).toBeDefined();
    });

    it('only skips a browser download for a dependency that stays out of the build', () => {
        // Both scripts set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD to keep a Chromium
        // this container will never open out of the install. That is safe
        // precisely because Playwright belongs to a maintainer script; promote
        // it to a runtime dependency and the saving becomes a missing browser.
        expect(pkg.dependencies.playwright).toBeUndefined();
        expect(pkg.devDependencies.playwright).toBeDefined();
        for (const script of [install, ct]) {
            expect(script).toContain('export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1');
            expect(script).toContain('$STD npm ci');
        }
    });

    it('declares the resources the container script asks for', () => {
        // Two answers to the same question, and the person sizing a node reads
        // the one that is not executed.
        const varIn = (name: string): string | undefined =>
            new RegExp(`^${name}="\\$\\{${name}:-([^}]+)\\}"`, 'm').exec(ct)?.[1];
        const { resources } = json.install_methods[0]!;

        expect(String(resources.cpu)).toBe(varIn('var_cpu'));
        expect(String(resources.ram)).toBe(varIn('var_ram'));
        expect(String(resources.hdd)).toBe(varIn('var_disk'));
        expect(String(resources.version)).toBe(varIn('var_version'));
        expect(resources.os.toLowerCase()).toBe(varIn('var_os'));
    });

    it('does not claim an architecture nobody has run it on', () => {
        // The convention is that an unset var_arm64 asks, and the JSON field
        // has to be absent to match. Declaring amd64 only says "arm64 is known
        // broken", which is a stronger and different claim than the truth —
        // the published image has an arm64 variant and this has simply never
        // been built on one.
        expect(/^var_arm64=/m.test(ct)).toBe(false);
        expect(json.architectures).toBeUndefined();
    });

    it('sends testers to the same place the README does', () => {
        // Every container the script builds repeats this URL — at each login,
        // in its Proxmox description and on the last line of the install — so a
        // stale one is repeated at the person best placed to report the thing
        // it is asking about.
        const testurl = /^var_testurl="\$\{var_testurl:-(\S+)\}"/m.exec(ct)?.[1];

        expect(testurl).toMatch(/^https:\/\//);
        expect(readme).toContain(testurl);
    });

    it('promises an update path the container script implements', () => {
        expect(json.updateable).toBe(true);
        expect(ct).toContain('function update_script()');
        expect(ct).toContain('check_for_gh_release "arr-mcp" "bardesss/arr-mcp"');
    });

    it('points its logo at a file that exists', () => {
        const logo = /cdn\.jsdelivr\.net\/gh\/bardesss\/arr-mcp@main\/(\S+)$/.exec(json.logo)?.[1];

        expect(logo).toBeDefined();
        expect(existsSync(join(root, logo!)), `${logo} is referenced but missing`).toBe(true);
    });
});
