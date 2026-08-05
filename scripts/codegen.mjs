// Generates type-only definitions from the vendored specs.
//
// Two deliberate choices here, both forced by the environment:
//
// 1. A Node script rather than a shell loop in package.json. npm runs scripts
//    through cmd.exe on Windows, where POSIX loop syntax is a syntax error —
//    and that is the machine this is actually run on.
//
// 2. `npx` with an exact version rather than a devDependency.
//    openapi-typescript declares `peer typescript@"^5.x"` and this project is
//    pinned to TypeScript 6.0.3 (because typescript-eslint requires <6.1.0),
//    so installing it locally fails to resolve. The alternatives were
//    `--legacy-peer-deps`, which every contributor and every future install
//    would have to carry and which disables peer checking project-wide, or
//    this: run it in npx's isolated tree, where its TypeScript 5 peer and our
//    TypeScript 6 never meet.
//
//    That is sound because this tool is not part of the shipped artefact. Its
//    *output* is committed and reviewed, CI never runs codegen, and a version
//    bump is a visible diff rather than a silent runtime change.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const GENERATOR = 'openapi-typescript@7.13.0';
const SERVICES = ['radarr', 'sonarr', 'prowlarr', 'jellyfin', 'seerr'];
const OUT_DIR = 'src/services/generated';

mkdirSync(OUT_DIR, { recursive: true });

/**
 * `npx` is a .cmd shim on Windows, which `execFileSync` cannot spawn directly.
 * Going through cmd.exe explicitly is the way that neither fails nor triggers
 * Node's DEP0190 warning, which `{ shell: true }` prints on every run.
 */
const run = (args) =>
    process.platform === 'win32'
        ? execFileSync('cmd.exe', ['/c', 'npx', ...args], { stdio: 'inherit' })
        : execFileSync('npx', args, { stdio: 'inherit' });

for (const service of SERVICES) {
    console.log(`generating ${service}`);
    run(['--yes', GENERATOR, `specs/${service}.json`, '-o', `${OUT_DIR}/${service}.ts`]);
}
