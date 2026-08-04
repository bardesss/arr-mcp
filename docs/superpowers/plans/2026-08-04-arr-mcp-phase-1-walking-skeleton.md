# arr-mcp Phase 1 — Walking Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship arr-mcp 0.1.0 — a single Docker container serving a stateless MCP endpoint at protocol revision 2026-07-28 that answers `stack_health` against a real Radarr instance, with bearer auth, CI, and a release pipeline that publishes a tagged multi-arch image.

**Architecture:** One Hono HTTP server on port 6060 mounts three things: `createMcpHandler` from the MCP TypeScript SDK v2 at `/mcp` (behind bearer-token middleware), a `/healthz` liveness probe, and nothing else yet. A zod-validated YAML config loader reads `/config/config.yaml` and generates the bearer token on first run. One `ServiceAdapter` implementation (Radarr) returns a `ConnectionDiagnosis` rather than a boolean, and the single `stack_health` tool composes adapter results into a shaped, truncation-honest response.

**Tech Stack:** TypeScript 7, Node 24 LTS, Hono 4, `@modelcontextprotocol/server` v2 + `@modelcontextprotocol/hono`, zod 4 (`zod/v4`), pino 10, Vitest 4, better-sqlite3 13 (dependency added but unused until Phase 4), Docker Buildx, release-please.

## Global Constraints

Copied verbatim from `docs/superpowers/specs/2026-08-04-arr-mcp-design.md`. Every task's requirements implicitly include this section.

- **Port: 6060.** Clear of Radarr 7878, Sonarr 8989, Prowlarr 9696, Bazarr 6767, Jellyfin 8096, Seerr 5055, SABnzbd 8080, Transmission 9091.
- **Protocol revision: 2026-07-28.** The legacy HTTP+SSE transport **must not be adopted**. **No session state may be introduced into the transport layer** — that is the one way to get this wrong. Roots, Sampling, and Logging are deprecated and are not used.
- **Repository / images:** `github.com/bardesss/arr-mcp` → `ghcr.io/bardesss/arr-mcp`.
- **Licence: MIT.** Clean-room — no upstream code from `BerryKuipers/mcp_services_radarr_sonarr` is copied or consulted while writing. Upstream is credited in the README as prior art.
- **Endpoint auth: bearer token, required, generated on first run.** `/mcp` and `/api/*` share the same token. "LAN-only" is a network assumption, not a security control.
- **Config storage:** `/config` volume. `config.yaml` (zod-validated, hot-reloaded) and `state.db` (SQLite). The web UI is the source of truth from Phase 5; environment variables seed first-run defaults only.
- **Error taxonomy, every adapter:** `Unreachable`, `AuthFailed`, `NotFound`, `RateLimited`, `Timeout`, `VersionUnsupported`, `UpstreamError`. Errors reach the model as structured, actionable text — never a stack trace.
- **Timeouts and retries:** per-service timeout 10 s (configurable). Circuit breaker opens after 5 consecutive failures, half-opens for a single trial request after 60 s. **Reads retry once on timeout; writes never auto-retry.**
- **Cross-service tools degrade, they do not fail.** `stack_health` returns what it gathered plus `degraded: ["<service>"]`.
- **Response shaping, every read tool:** `detail: minimal | standard | full` (default `standard`), `limit` (default 50, hard maximum 500 regardless of what is requested). Truncated responses **must** return `{ total, returned, truncated: true }` — silent truncation is how a model confidently reports that a 900-film library contains 50 films.
- **`testConnection` returns a diagnosis, not a boolean.** It distinguishes DNS failure, connection refused, TLS error, 401 bad key, 404 wrong base path, and version-too-old, and states the remedy.
- **Permission tiers:** read always on; safe-write on per-service; destructive **off**. Phase 1 ships read only, but the config schema carries the toggles.
- **Container:** multi-stage Dockerfile, non-root, `PUID`/`PGID` for the `/config` volume per linuxserver convention.
- **Branching:** trunk-based. `main` always releasable, short-lived branches, **squash merge**, linear history. Branch protection requires status checks and a PR, no direct pushes. **Approvals are not required** — a solo maintainer cannot approve their own PR.
- **Versioning: 0.x until phase 6 ships, then 1.0.0.** Conventional Commits drive release-please.
- **Image tags:** `X.Y.Z`, `X.Y`, `X`, `latest` for stable, plus `main` for bleeding edge. Nothing else.
- **The tool surface is the public API.** Renaming a tool or dropping a parameter breaks users' saved prompts silently.

## Resolved Open Questions

Two items from spec §21 were resolved before planning; the plan depends on these answers.

**§21.5 — TypeScript SDK support for protocol revision 2026-07-28: RESOLVED, no schedule risk.** `@modelcontextprotocol/server@2.0.0` and `@modelcontextprotocol/client@2.0.0` are published on npm under the `latest` dist-tag (the alpha/beta prereleases are behind them), and the v2 line implements the 2026-07-28 revision. The spec's contingency — pinning the prior revision or implementing the transport directly — is **not needed**. `createMcpHandler` serves 2026-07-28 by default.

Two consequences worth writing down:

- **`createMcpHandler(factory)` runs the factory once per request**, producing a fresh `McpServer` per call. This is the stateless model the spec demands, enforced by the SDK's own shape rather than by our discipline.
- **`@modelcontextprotocol/hono@2.0.0` exists** and is the official Hono adapter (peer deps `hono ^4.11.4`, `@modelcontextprotocol/server ^2.0.0`). The spec's Hono choice is directly supported; we do not hand-roll transport plumbing.

**§21.6 — MRTR client support detection: PARTIALLY RESOLVED, revisit in Phase 4.** The SDK exposes an `inputRequired()` return helper and threads multi-round state through a codec-sealed `requestState` string. For 2025-era clients a legacy shim converts an `inputRequired` return into a real server→client request. That shim may mean destructive confirmation degrades to elicitation rather than vanishing — which would soften the spec §10 rule that destructive tools are withheld entirely. **Do not act on this in Phase 1.** Phase 4 must verify against a real client whether the shim's elicitation path is guaranteed, because the spec's safety property depends on it.

## Deviations From The Spec

Two, both flagged for the maintainer rather than silently applied. **Task 1 asks for a decision on the first before pinning anything.**

1. **Node 22 → Node 24.** The spec says Node 22 LTS. Node 22 entered maintenance on 2025-10-21 (EOL 2027-04-30); **Node 24 is the current Active LTS** until 2026-10-20 (EOL 2028-04-30). Both satisfy the SDK's `engines: {node: ">=20"}`. Starting a new project on a maintenance-mode runtime buys nothing. This plan pins **Node 24**; if the maintainer prefers 22, change the three places named in Task 1 Step 3.
2. **OpenAPI codegen deferred to Phase 2.** The spec puts `openapi-typescript` + vendored specs in the architecture, and contract tests in §17 — but §20 assigns "recorded fixtures, contract tests" to Phase 2. Phase 1 therefore hand-writes the four Radarr response types it needs. `openapi-typescript` is **not** added as a dependency until Phase 2, so Phase 1 has no vendored spec to drift.

---

## File Structure

```
arr-mcp/
├─ .github/workflows/
│  ├─ ci.yml                    # lint, typecheck, test, docker build (no push)
│  ├─ release.yml               # release-please + buildx → GHCR + SBOM/provenance
│  └─ openapi-drift.yml         # nightly; Phase 2 fills in the spec list
├─ src/
│  ├─ index.ts                  # entrypoint: load config, build app, listen
│  ├─ app.ts                    # Hono app assembly: /healthz, auth, /mcp mount
│  ├─ config/
│  │  ├─ schema.ts              # zod schema + inferred Config type
│  │  └─ load.ts                # read/create /config/config.yaml, token generation
│  ├─ core/
│  │  ├─ errors.ts              # ServiceError taxonomy + toModelText()
│  │  ├─ logger.ts              # pino instance
│  │  └─ shape.ts               # applyLimit(): the {total,returned,truncated} contract
│  ├─ services/
│  │  ├─ types.ts               # ServiceAdapter, ConnectionDiagnosis, ServiceId
│  │  └─ radarr.ts              # RadarrAdapter
│  └─ tools/
│     └─ stackHealth.ts         # registerStackHealth(server, adapters)
├─ test/
│  ├─ config.test.ts
│  ├─ errors.test.ts
│  ├─ shape.test.ts
│  ├─ radarr.test.ts
│  ├─ app.test.ts               # auth rejection + /healthz
│  └─ stackHealth.test.ts
├─ Dockerfile
├─ docker-entrypoint.sh         # PUID/PGID drop-privileges shim
├─ docker-compose.example.yml
├─ package.json
├─ tsconfig.json
├─ eslint.config.mjs
├─ vitest.config.ts
├─ release-please-config.json
├─ .release-please-manifest.json
├─ LICENSE                      # MIT
├─ README.md
└─ CONTRIBUTING.md
```

Rationale for the boundaries: `config/`, `core/`, `services/`, and `tools/` are the spec's own §5 module names, so a reader who knows the spec can navigate the tree. `core/shape.ts` is separate from any tool because §12's truncation contract must be one implementation that every future read tool shares — duplicating it is how a 900-film library silently becomes 50.

---

## Task 1: Repository bootstrap, toolchain, and CI gate

Folds in: git init, GitHub repo creation, branch protection, licence, README, and the CI workflow. These are one reviewable unit — "the repo exists and rejects broken code" — and none of them is independently testable without the others.

**Files:**
- Create: `package.json`, `tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`, `.gitignore`, `LICENSE`, `README.md`, `CONTRIBUTING.md`, `.github/workflows/ci.yml`, `test/smoke.test.ts`, `src/core/logger.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `logger` (a pino `Logger`) exported from `src/core/logger.ts`; npm scripts `lint`, `typecheck`, `test`, `build`, `dev`; a green CI workflow every later task extends.

- [ ] **Step 1: Confirm the Node version decision**

Ask the maintainer: Node 24 (this plan's default, current Active LTS) or Node 22 (as written in the spec, in maintenance since 2025-10-21)? If 22 is chosen, substitute `22` for `24` in `package.json` `engines`, `.github/workflows/ci.yml`, and the `Dockerfile` base image in Task 8. Do not proceed until answered — it is pinned in three files and cheaper to decide once.

- [ ] **Step 2: Create the GitHub repository**

```bash
mkdir -p ~/Dev/arr-mcp && cd ~/Dev/arr-mcp
git init -b main
gh repo create bardesss/arr-mcp --public \
  --description "One MCP server for the whole self-hosted media stack: Radarr, Sonarr, Prowlarr, Bazarr, Jellyfin, Seerr, SABnzbd, Transmission." \
  --source . --remote origin
```

Note: the existing design spec lives in a separate working directory. Copy `docs/superpowers/` into the new repo so the spec and plan travel with the code:

```bash
mkdir -p docs/superpowers
cp -r ~/Dev/selfhostedmediamcp/docs/superpowers/. docs/superpowers/
```

- [ ] **Step 3: Write `package.json`**

```json
{
  "name": "arr-mcp",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=24" },
  "scripts": {
    "dev": "node --watch --experimental-strip-types src/index.ts",
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@hono/node-server": "^2.1.0",
    "@modelcontextprotocol/hono": "^2.0.0",
    "@modelcontextprotocol/server": "^2.0.0",
    "better-sqlite3": "^13.0.2",
    "hono": "^4.13.0",
    "pino": "^10.3.1",
    "yaml": "^2.8.1",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@modelcontextprotocol/client": "^2.0.0",
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^24.9.2",
    "eslint": "^10.8.0",
    "typescript": "^7.0.2",
    "typescript-eslint": "^9.1.0",
    "vitest": "^4.1.10"
  }
}
```

`better-sqlite3` is declared now because the Dockerfile's native-build stage (Task 7) must be proven to work before Phase 4 depends on it. Nothing imports it in Phase 1.

- [ ] **Step 4: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "es2023",
    "lib": ["es2023"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "outDir": "dist",
    "rootDir": ".",
    "sourceMap": true,
    "declaration": false,
    "skipLibCheck": true
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 5: Write `eslint.config.mjs` and `vitest.config.ts`**

```js
// eslint.config.mjs
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['dist', 'node_modules'] },
    js.configs.recommended,
    ...tseslint.configs.recommended
);
```

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        environment: 'node'
    }
});
```

- [ ] **Step 6: Write `.gitignore`**

```gitignore
node_modules/
dist/
*.log
config/
.env
```

- [ ] **Step 7: Write the failing smoke test**

```ts
// test/smoke.test.ts
import { describe, expect, it } from 'vitest';
import { logger } from '../src/core/logger.ts';

describe('toolchain', () => {
    it('exposes a logger with the service name bound', () => {
        expect(logger).toBeDefined();
        expect(typeof logger.info).toBe('function');
        expect(logger.bindings().service).toBe('arr-mcp');
    });
});
```

- [ ] **Step 8: Run the test to verify it fails**

```bash
npm install && npm test
```

Expected: FAIL — `Cannot find module '../src/core/logger.ts'`.

- [ ] **Step 9: Write `src/core/logger.ts`**

```ts
import pino from 'pino';

/**
 * Process-wide logger. Writes to stdout; the SQLite ring buffer sink
 * arrives in Phase 5 with the config UI's log streams.
 */
export const logger = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service: 'arr-mcp' }
});
```

- [ ] **Step 10: Run the test to verify it passes**

```bash
npm test
```

Expected: PASS — 1 test.

- [ ] **Step 11: Write `LICENSE`, `README.md`, `CONTRIBUTING.md`**

`LICENSE` is the standard MIT text, copyright `2026 bardesss`.

`README.md` must lead with the differentiator, because spec §17/§19 identify discovery as the binding constraint — fourteen comparable servers exist and essentially none has users. Open with the two things no comparable project does:

```markdown
# arr-mcp

One MCP server for your whole self-hosted media stack — not one per service.

Ask questions no single service can answer: *"Why isn't the film I requested
on Tuesday showing up in Jellyfin?"* spans Seerr, Radarr, Prowlarr, SABnzbd
and Jellyfin. arr-mcp correlates them.

- **A web config page** that diagnoses connections instead of printing
  pass/fail, and shows live logs while you debug.
- **Tool output is treated as untrusted data, never instruction.** Release
  names from public indexers are attacker-controllable and flow straight into
  model context; arr-mcp fences them.
- **Safe by default.** Deletion is off until you deliberately enable it, and
  then still asks per call.

> **Status: 0.1 walking skeleton.** Radarr and `stack_health` only. See the
> roadmap for what lands when.

## Prior art

Inspired by [`BerryKuipers/mcp_services_radarr_sonarr`](https://github.com/BerryKuipers/mcp_services_radarr_sonarr),
which showed the demand for this and is no longer maintained. arr-mcp is a
clean-room implementation and shares no code with it.
```

`CONTRIBUTING.md` covers local development against fixtures with no media stack required, and states the Conventional Commits requirement.

- [ ] **Step 12: Write `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: '24'
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test

  docker:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: docker/setup-buildx-action@v3
      - name: Build image (no push)
        uses: docker/build-push-action@v6
        with:
          context: .
          push: false
```

The `docker` job fails until Task 7 adds the Dockerfile. That is intentional and correct — CI should be red on an incomplete skeleton. Do not add a `continue-on-error`.

- [ ] **Step 13: Commit and push**

```bash
git add -A
git commit -m "chore: bootstrap toolchain, licence, and CI gate"
git push -u origin main
```

- [ ] **Step 14: Configure branch protection**

Requires status checks and a PR; **does not** require approvals, per the Global Constraints.

```bash
gh api -X PUT repos/bardesss/arr-mcp/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  -f "required_status_checks[strict]=true" \
  -f "required_status_checks[contexts][]=check" \
  -F "enforce_admins=false" \
  -F "required_pull_request_reviews=null" \
  -F "restrictions=null" \
  -F "allow_force_pushes=false" \
  -F "allow_deletions=false" \
  -F "required_linear_history=true"
```

Then set squash-merge as the only merge method:

```bash
gh api -X PATCH repos/bardesss/arr-mcp \
  -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false \
  -F delete_branch_on_merge=true
```

Note `required_status_checks[contexts][]=check` names only the `check` job, not `docker`. Add `docker` to the required contexts in Task 8, once it can pass.

---

## Task 2: Config schema and loader

**Files:**
- Create: `src/config/schema.ts`, `src/config/load.ts`, `test/config.test.ts`

**Interfaces:**
- Consumes: `logger` from `src/core/logger.ts`.
- Produces:
  - `ServiceIdSchema`, `type ServiceId = 'radarr' | 'sonarr' | 'prowlarr' | 'bazarr' | 'jellyfin' | 'seerr' | 'sabnzbd' | 'transmission'`
  - `ConfigSchema`, `type Config = z.infer<typeof ConfigSchema>`
  - `loadConfig(configDir: string): Promise<{ config: Config; created: boolean }>`
  - `type ServiceConfig = { url: string; api_key: string; timeout_ms: number; permissions: { safe_write: boolean; destructive: boolean } }`

- [ ] **Step 1: Write the failing tests**

```ts
// test/config.test.ts
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config/schema.ts';
import { loadConfig } from '../src/config/load.ts';

const freshDir = () => mkdtemp(join(tmpdir(), 'arr-mcp-cfg-'));

const AUTH = { bearer_token: 'a'.repeat(64) };

describe('ConfigSchema', () => {
    it('defaults both permission tiers to off for a newly added service', () => {
        const parsed = ConfigSchema.parse({
            auth: AUTH,
            services: { radarr: { url: 'http://192.168.1.20:7878', api_key: 'k' } }
        });
        expect(parsed.services.radarr?.permissions).toEqual({ safe_write: false, destructive: false });
    });

    it('defaults the per-service timeout to 10 seconds', () => {
        const parsed = ConfigSchema.parse({
            auth: AUTH,
            services: { radarr: { url: 'http://h:7878', api_key: 'k' } }
        });
        expect(parsed.services.radarr?.timeout_ms).toBe(10_000);
    });

    it('defaults allowed_hosts to an empty list', () => {
        const parsed = ConfigSchema.parse({ auth: AUTH, services: {} });
        expect(parsed.auth.allowed_hosts).toEqual([]);
    });

    it('rejects a service url that is not http(s)', () => {
        const result = ConfigSchema.safeParse({
            auth: AUTH,
            services: { radarr: { url: 'ftp://h:7878', api_key: 'k' } }
        });
        expect(result.success).toBe(false);
    });

    it('rejects an empty api key rather than silently accepting it', () => {
        const result = ConfigSchema.safeParse({
            auth: AUTH,
            services: { radarr: { url: 'http://h:7878', api_key: '' } }
        });
        expect(result.success).toBe(false);
    });

    it('rejects a config whose auth block was deleted by hand', () => {
        expect(ConfigSchema.safeParse({ services: {} }).success).toBe(false);
    });
});

describe('loadConfig', () => {
    it('creates config.yaml with a generated bearer token on first run', async () => {
        const dir = await freshDir();
        const { config, created } = await loadConfig(dir);

        expect(created).toBe(true);
        expect(config.auth.bearer_token).toMatch(/^[0-9a-f]{64}$/);
        // and it is persisted, not just returned
        const onDisk = await readFile(join(dir, 'config.yaml'), 'utf8');
        expect(onDisk).toContain(config.auth.bearer_token);
    });

    it('is stable across restarts — the token is not regenerated', async () => {
        const dir = await freshDir();
        const first = await loadConfig(dir);
        const second = await loadConfig(dir);

        expect(second.created).toBe(false);
        expect(second.config.auth.bearer_token).toBe(first.config.auth.bearer_token);
    });

    it('throws an actionable error when config.yaml is malformed', async () => {
        const dir = await freshDir();
        await writeFile(join(dir, 'config.yaml'), 'services: [this is not a map]', 'utf8');

        await expect(loadConfig(dir)).rejects.toThrow(/config\.yaml/);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run test/config.test.ts
```

Expected: FAIL — `Cannot find module '../src/config/schema.ts'`.

- [ ] **Step 3: Write `src/config/schema.ts`**

```ts
import * as z from 'zod/v4';

export const ServiceIdSchema = z.enum([
    'radarr',
    'sonarr',
    'prowlarr',
    'bazarr',
    'jellyfin',
    'seerr',
    'sabnzbd',
    'transmission'
]);
export type ServiceId = z.infer<typeof ServiceIdSchema>;

/**
 * Permission tiers per spec §10. Both default to off: a service added by
 * hand-editing YAML must not silently acquire write access.
 */
const PermissionsSchema = z
    .object({
        safe_write: z.boolean().default(false),
        destructive: z.boolean().default(false)
    })
    .default({ safe_write: false, destructive: false });

const ServiceConfigSchema = z.object({
    url: z
        .url()
        .refine(u => u.startsWith('http://') || u.startsWith('https://'), {
            message: 'must be an http:// or https:// URL'
        }),
    api_key: z.string().min(1, 'api_key must not be empty'),
    timeout_ms: z.number().int().positive().default(10_000),
    permissions: PermissionsSchema
});
export type ServiceConfig = z.infer<typeof ServiceConfigSchema>;

export const ConfigSchema = z.object({
    // Required, not optional: loadConfig always injects a generated token
    // before parsing, so the only way this is missing is a hand-edited file
    // that deleted it — which must fail loudly rather than default to ''.
    auth: z.object({
        /** Generated on first run by loadConfig; 32 random bytes, hex. */
        bearer_token: z.string().length(64),
        /**
         * Hostnames the MCP endpoint may be reached on, for the SDK's DNS
         * rebinding protection. Empty means "accept any Host", which is the
         * right default for a LAN container reached by IP; pin hostnames when
         * running behind a reverse proxy.
         */
        allowed_hosts: z.array(z.string()).default([])
    }),
    services: z.partialRecord(ServiceIdSchema, ServiceConfigSchema).default({})
});
export type Config = z.infer<typeof ConfigSchema>;
```

- [ ] **Step 4: Write `src/config/load.ts`**

```ts
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { logger } from '../core/logger.ts';
import { ConfigSchema, type Config } from './schema.ts';

const FILENAME = 'config.yaml';

const generateToken = (): string => randomBytes(32).toString('hex');

/**
 * Reads /config/config.yaml, creating it with a generated bearer token on
 * first run. Environment variables seed first-run defaults only — after that
 * the file is the source of truth (spec §13).
 */
export async function loadConfig(configDir: string): Promise<{ config: Config; created: boolean }> {
    const path = join(configDir, FILENAME);
    await mkdir(configDir, { recursive: true });

    let raw: string | undefined;
    try {
        raw = await readFile(path, 'utf8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    if (raw === undefined) {
        const seeded = {
            auth: { bearer_token: generateToken() },
            services: {}
        };
        await writeFile(path, stringify(seeded), { mode: 0o600 });
        logger.info({ path }, 'created config.yaml with a generated bearer token');
        return { config: ConfigSchema.parse(seeded), created: true };
    }

    let parsed: unknown;
    try {
        parsed = parse(raw);
    } catch (err) {
        throw new Error(`config.yaml is not valid YAML: ${(err as Error).message}`);
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('config.yaml must contain a YAML mapping at the top level');
    }

    const obj = parsed as Record<string, unknown>;
    const auth = obj.auth as { bearer_token?: string } | undefined;
    if (!auth?.bearer_token) {
        obj.auth = { bearer_token: generateToken() };
        await writeFile(path, stringify(obj), { mode: 0o600 });
        logger.warn({ path }, 'config.yaml had no bearer token; generated one');
    }

    const result = ConfigSchema.safeParse(obj);
    if (!result.success) {
        throw new Error(`config.yaml is invalid: ${z.prettifyError(result.error)}`);
    }
    return { config: result.data, created: false };
}
```

Add `import * as z from 'zod/v4';` at the top for `z.prettifyError`.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run test/config.test.ts
```

Expected: PASS — 9 tests. If `z.partialRecord` is unavailable in the installed zod build, substitute `z.record(ServiceIdSchema, ServiceConfigSchema).partial()` and re-run; the test assertions do not change.

- [ ] **Step 6: Commit**

```bash
git add src/config test/config.test.ts
git commit -m "feat: add zod-validated config loader with first-run token generation"
```

---

## Task 3: Error taxonomy

**Files:**
- Create: `src/core/errors.ts`, `test/errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ServiceErrorKind = 'Unreachable' | 'AuthFailed' | 'NotFound' | 'RateLimited' | 'Timeout' | 'VersionUnsupported' | 'UpstreamError'`
  - `class ServiceError extends Error` with `readonly kind: ServiceErrorKind`, `readonly service: ServiceId`, `readonly remedy: string | undefined`, and `toModelText(): string`
  - `classifyFetchError(err: unknown, service: ServiceId, url: string): ServiceError`
  - `classifyHttpStatus(status: number, service: ServiceId, url: string): ServiceError | undefined`

- [ ] **Step 1: Write the failing tests**

```ts
// test/errors.test.ts
import { describe, expect, it } from 'vitest';
import { ServiceError, classifyFetchError, classifyHttpStatus } from '../src/core/errors.ts';

describe('ServiceError.toModelText', () => {
    it('produces actionable text naming the service, cause, and target', () => {
        const err = new ServiceError('Unreachable', 'bazarr', 'connection refused at 192.168.1.20:6767');
        expect(err.toModelText()).toBe('bazarr unreachable: connection refused at 192.168.1.20:6767');
    });

    it('appends the remedy when one is known', () => {
        const err = new ServiceError('AuthFailed', 'radarr', 'HTTP 401 at /api/v3/system/status', {
            remedy: 'The API key is wrong. Radarr → Settings → General.'
        });
        expect(err.toModelText()).toBe(
            'radarr auth failed: HTTP 401 at /api/v3/system/status — The API key is wrong. Radarr → Settings → General.'
        );
    });

    it('never leaks a stack trace into model-facing text', () => {
        const err = new ServiceError('UpstreamError', 'radarr', 'boom');
        expect(err.toModelText()).not.toContain('at ');
        expect(err.toModelText()).not.toContain(import.meta.url);
    });
});

describe('classifyHttpStatus', () => {
    it.each([
        [401, 'AuthFailed'],
        [403, 'AuthFailed'],
        [404, 'NotFound'],
        [429, 'RateLimited'],
        [500, 'UpstreamError'],
        [502, 'UpstreamError']
    ])('maps HTTP %i to %s', (status, kind) => {
        expect(classifyHttpStatus(status, 'radarr', 'http://h/api')?.kind).toBe(kind);
    });

    it('returns undefined for a success status', () => {
        expect(classifyHttpStatus(200, 'radarr', 'http://h/api')).toBeUndefined();
    });

    it('gives a 404 the wrong-base-path remedy, not a generic message', () => {
        expect(classifyHttpStatus(404, 'radarr', 'http://h/api/v3/system/status')?.remedy).toMatch(/base path/i);
    });
});

describe('classifyFetchError', () => {
    it('maps DNS failure to Unreachable with a DNS remedy', () => {
        const e = Object.assign(new Error('getaddrinfo ENOTFOUND nope'), { code: 'ENOTFOUND' });
        const out = classifyFetchError(e, 'radarr', 'http://nope:7878');
        expect(out.kind).toBe('Unreachable');
        expect(out.remedy).toMatch(/hostname/i);
    });

    it('maps connection refused to Unreachable', () => {
        const e = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        expect(classifyFetchError(e, 'radarr', 'http://h:7878').kind).toBe('Unreachable');
    });

    it('maps an AbortError to Timeout', () => {
        const e = Object.assign(new Error('aborted'), { name: 'AbortError' });
        expect(classifyFetchError(e, 'radarr', 'http://h:7878').kind).toBe('Timeout');
    });

    it('maps a TLS certificate failure to Unreachable with a TLS remedy', () => {
        const e = Object.assign(new Error('self-signed'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
        expect(classifyFetchError(e, 'radarr', 'https://h:7878').remedy).toMatch(/certificate/i);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run test/errors.test.ts
```

Expected: FAIL — `Cannot find module '../src/core/errors.ts'`.

- [ ] **Step 3: Write `src/core/errors.ts`**

```ts
import type { ServiceId } from '../config/schema.ts';

export type ServiceErrorKind =
    | 'Unreachable'
    | 'AuthFailed'
    | 'NotFound'
    | 'RateLimited'
    | 'Timeout'
    | 'VersionUnsupported'
    | 'UpstreamError';

const PROSE: Record<ServiceErrorKind, string> = {
    Unreachable: 'unreachable',
    AuthFailed: 'auth failed',
    NotFound: 'not found',
    RateLimited: 'rate limited',
    Timeout: 'timed out',
    VersionUnsupported: 'version unsupported',
    UpstreamError: 'upstream error'
};

/**
 * A model told *why* something failed reports it; a model handed an opaque
 * error invents an explanation (spec §15). `toModelText` is the only string
 * that ever reaches the model — it never includes a stack trace.
 */
export class ServiceError extends Error {
    readonly kind: ServiceErrorKind;
    readonly service: ServiceId;
    readonly detail: string;
    readonly remedy: string | undefined;

    constructor(
        kind: ServiceErrorKind,
        service: ServiceId,
        detail: string,
        opts?: { remedy?: string; cause?: unknown }
    ) {
        super(`${service} ${PROSE[kind]}: ${detail}`, opts?.cause ? { cause: opts.cause } : undefined);
        this.name = 'ServiceError';
        this.kind = kind;
        this.service = service;
        this.detail = detail;
        this.remedy = opts?.remedy;
    }

    toModelText(): string {
        const base = `${this.service} ${PROSE[this.kind]}: ${this.detail}`;
        return this.remedy ? `${base} — ${this.remedy}` : base;
    }
}

export function classifyHttpStatus(status: number, service: ServiceId, url: string): ServiceError | undefined {
    if (status < 400) return undefined;
    const at = `HTTP ${status} at ${new URL(url).pathname}`;

    if (status === 401 || status === 403) {
        return new ServiceError('AuthFailed', service, at, {
            remedy: 'The API key is wrong. Check the service’s Settings → General page.'
        });
    }
    if (status === 404) {
        return new ServiceError('NotFound', service, at, {
            remedy: 'Wrong base path — check the URL does not include a trailing path or reverse-proxy prefix.'
        });
    }
    if (status === 429) {
        return new ServiceError('RateLimited', service, at);
    }
    return new ServiceError('UpstreamError', service, at);
}

const TLS_CODES = new Set([
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'CERT_HAS_EXPIRED',
    'ERR_TLS_CERT_ALTNAME_INVALID'
]);

export function classifyFetchError(err: unknown, service: ServiceId, url: string): ServiceError {
    const e = err as { name?: string; code?: string; message?: string; cause?: { code?: string } };
    const code = e.code ?? e.cause?.code;
    const host = (() => {
        try {
            return new URL(url).host;
        } catch {
            return url;
        }
    })();

    if (e.name === 'AbortError' || e.name === 'TimeoutError') {
        return new ServiceError('Timeout', service, `no response from ${host} within the configured timeout`, {
            cause: err
        });
    }
    if (code && TLS_CODES.has(code)) {
        return new ServiceError('Unreachable', service, `TLS error (${code}) at ${host}`, {
            remedy: 'The TLS certificate could not be verified. Use http:// on the LAN, or install a trusted certificate.',
            cause: err
        });
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
        return new ServiceError('Unreachable', service, `DNS lookup failed for ${host}`, {
            remedy: 'The hostname does not resolve. Use an IP address, or check your DNS.',
            cause: err
        });
    }
    if (code === 'ECONNREFUSED') {
        return new ServiceError('Unreachable', service, `connection refused at ${host}`, {
            remedy: 'Nothing is listening on that port. Check the service is running and the port is right.',
            cause: err
        });
    }
    return new ServiceError('Unreachable', service, `${e.message ?? 'unknown error'} at ${host}`, { cause: err });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run test/errors.test.ts
```

Expected: PASS — 14 tests (the `it.each` counts as 6).

- [ ] **Step 5: Commit**

```bash
git add src/core/errors.ts test/errors.test.ts
git commit -m "feat: add typed error taxonomy with actionable model-facing text"
```

---

## Task 4: Response shaping contract

Small but load-bearing. It gets its own task because every read tool in every later phase depends on it, and a reviewer should be able to reject the truncation semantics independently of any tool.

**Files:**
- Create: `src/core/shape.ts`, `test/shape.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `const DETAIL_LEVELS = ['minimal', 'standard', 'full'] as const`
  - `type DetailLevel = 'minimal' | 'standard' | 'full'`
  - `DetailSchema` (zod enum, default `'standard'`) and `LimitSchema` (zod int, default 50, max 500)
  - `applyLimit<T>(items: readonly T[], limit: number): { items: T[]; total: number; returned: number; truncated: boolean }`
  - `MAX_LIMIT = 500`, `DEFAULT_LIMIT = 50`

- [ ] **Step 1: Write the failing tests**

```ts
// test/shape.test.ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMIT, DetailSchema, LimitSchema, MAX_LIMIT, applyLimit } from '../src/core/shape.ts';

describe('applyLimit', () => {
    it('reports truncation honestly when the list is longer than the limit', () => {
        const out = applyLimit(Array.from({ length: 900 }, (_, i) => i), 50);
        expect(out.returned).toBe(50);
        expect(out.total).toBe(900);
        expect(out.truncated).toBe(true);
    });

    it('reports truncated: false when everything fits', () => {
        const out = applyLimit([1, 2, 3], 50);
        expect(out).toEqual({ items: [1, 2, 3], total: 3, returned: 3, truncated: false });
    });

    it('caps at MAX_LIMIT regardless of what was requested', () => {
        const out = applyLimit(Array.from({ length: 2000 }, (_, i) => i), 9999);
        expect(out.returned).toBe(MAX_LIMIT);
        expect(out.truncated).toBe(true);
    });

    it('handles an empty list without claiming truncation', () => {
        expect(applyLimit([], 50)).toEqual({ items: [], total: 0, returned: 0, truncated: false });
    });
});

describe('schemas', () => {
    it('defaults detail to standard', () => {
        expect(DetailSchema.parse(undefined)).toBe('standard');
    });

    it('defaults limit to 50', () => {
        expect(LimitSchema.parse(undefined)).toBe(DEFAULT_LIMIT);
    });

    it('rejects a limit above the hard maximum at the schema boundary', () => {
        expect(LimitSchema.safeParse(501).success).toBe(false);
    });

    it('rejects a non-positive limit', () => {
        expect(LimitSchema.safeParse(0).success).toBe(false);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run test/shape.test.ts
```

Expected: FAIL — `Cannot find module '../src/core/shape.ts'`.

- [ ] **Step 3: Write `src/core/shape.ts`**

```ts
import * as z from 'zod/v4';

export const DETAIL_LEVELS = ['minimal', 'standard', 'full'] as const;
export type DetailLevel = (typeof DETAIL_LEVELS)[number];

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;

export const DetailSchema = z
    .enum(DETAIL_LEVELS)
    .default('standard')
    .describe('How much per-item detail to return. Defaults to standard.');

export const LimitSchema = z
    .number()
    .int()
    .positive()
    .max(MAX_LIMIT)
    .default(DEFAULT_LIMIT)
    .describe(`Maximum items to return. Defaults to ${DEFAULT_LIMIT}, hard maximum ${MAX_LIMIT}.`);

/**
 * The truncation contract from spec §12. Silent truncation is how a model
 * confidently reports that a 900-film library contains 50 films, so every
 * read tool routes its list through here and serialises all four fields.
 *
 * `limit` is clamped defensively even though LimitSchema also caps it —
 * a future internal caller that bypasses the schema must not be able to
 * request 5000 items.
 */
export function applyLimit<T>(
    items: readonly T[],
    limit: number
): { items: T[]; total: number; returned: number; truncated: boolean } {
    const effective = Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
    const sliced = items.slice(0, effective);
    return {
        items: sliced,
        total: items.length,
        returned: sliced.length,
        truncated: sliced.length < items.length
    };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run test/shape.test.ts
```

Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/shape.ts test/shape.test.ts
git commit -m "feat: add response shaping with explicit truncation contract"
```

---

## Task 5: Radarr adapter

**Files:**
- Create: `src/services/types.ts`, `src/services/radarr.ts`, `test/radarr.test.ts`

**Interfaces:**
- Consumes: `ServiceError`, `classifyFetchError`, `classifyHttpStatus` from `src/core/errors.ts`; `ServiceConfig`, `ServiceId` from `src/config/schema.ts`.
- Produces:
  - `type ConnectionDiagnosis = { ok: boolean; service: ServiceId; latency_ms: number; version?: string; error?: { kind: ServiceErrorKind; detail: string; remedy?: string } }`
  - `interface ServiceAdapter { readonly id: ServiceId; testConnection(): Promise<ConnectionDiagnosis>; getVersion(): Promise<string> }`
  - `interface ArrAdapter extends ServiceAdapter { getDiskSpace(): Promise<DiskSpace[]>; getFailedHealthChecks(): Promise<HealthCheck[]> }`
  - `type DiskSpace = { path: string; label: string; freeSpace: number; totalSpace: number }`
  - `type HealthCheck = { source: string; type: string; message: string }`
  - `class RadarrAdapter implements ArrAdapter` — constructor `(config: ServiceConfig, fetchImpl?: typeof fetch)`

- [ ] **Step 1: Write the failing tests**

The adapter takes an injectable `fetch` so tests need no live Radarr. Fixture shapes below are Radarr v3's documented `/api/v3/system/status`, `/api/v3/diskspace`, and `/api/v3/health` responses, trimmed to the fields we consume.

**Verify these three shapes against a live Radarr in Task 10 Step 2** — spec §21 flags the Radarr schema as unconfirmed, and the fixtures here are the plan's best reading rather than a captured response. If a field name differs, fix the fixture and the type together.

```ts
// test/radarr.test.ts
import { describe, expect, it, vi } from 'vitest';
import { RadarrAdapter } from '../src/services/radarr.ts';
import type { ServiceConfig } from '../src/config/schema.ts';

const config: ServiceConfig = {
    url: 'http://192.168.1.20:7878',
    api_key: 'test-key',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
};

const STATUS = { appName: 'Radarr', version: '5.14.0.9383', instanceName: 'Radarr' };
const DISKSPACE = [{ path: '/movies', label: 'movies', freeSpace: 1_234_567_890, totalSpace: 9_876_543_210 }];
const HEALTH = [
    { source: 'IndexerStatusCheck', type: 'warning', message: 'Indexers unavailable due to failures' }
];

const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('RadarrAdapter', () => {
    it('sends the api key as the X-Api-Key header, never in the query string', async () => {
        const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input instanceof Request ? input.url : input);
            expect(url).not.toContain('test-key');
            expect(new Headers(init?.headers).get('X-Api-Key')).toBe('test-key');
            return jsonResponse(STATUS);
        });

        const adapter = new RadarrAdapter(config, fetchMock as unknown as typeof fetch);
        await adapter.getVersion();
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('returns the version from /api/v3/system/status', async () => {
        const adapter = new RadarrAdapter(config, (async () => jsonResponse(STATUS)) as unknown as typeof fetch);
        expect(await adapter.getVersion()).toBe('5.14.0.9383');
    });

    it('diagnoses a healthy instance with a latency measurement and version', async () => {
        const adapter = new RadarrAdapter(config, (async () => jsonResponse(STATUS)) as unknown as typeof fetch);
        const d = await adapter.testConnection();

        expect(d.ok).toBe(true);
        expect(d.service).toBe('radarr');
        expect(d.version).toBe('5.14.0.9383');
        expect(d.latency_ms).toBeGreaterThanOrEqual(0);
        expect(d.error).toBeUndefined();
    });

    it('diagnoses a bad api key as AuthFailed with a remedy, not as a thrown error', async () => {
        const adapter = new RadarrAdapter(
            config,
            (async () => jsonResponse({ message: 'Unauthorized' }, 401)) as unknown as typeof fetch
        );
        const d = await adapter.testConnection();

        expect(d.ok).toBe(false);
        expect(d.error?.kind).toBe('AuthFailed');
        expect(d.error?.remedy).toMatch(/api key/i);
    });

    it('diagnoses connection refused as Unreachable', async () => {
        const refuse = async () => {
            throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        };
        const adapter = new RadarrAdapter(config, refuse as unknown as typeof fetch);
        const d = await adapter.testConnection();

        expect(d.ok).toBe(false);
        expect(d.error?.kind).toBe('Unreachable');
    });

    it('returns only failing health checks, filtering out ok entries', async () => {
        const body = [...HEALTH, { source: 'X', type: 'ok', message: 'fine' }];
        const adapter = new RadarrAdapter(config, (async () => jsonResponse(body)) as unknown as typeof fetch);
        const checks = await adapter.getFailedHealthChecks();

        expect(checks).toHaveLength(1);
        expect(checks[0]?.source).toBe('IndexerStatusCheck');
    });

    it('returns disk space entries', async () => {
        const adapter = new RadarrAdapter(config, (async () => jsonResponse(DISKSPACE)) as unknown as typeof fetch);
        const disks = await adapter.getDiskSpace();

        expect(disks).toHaveLength(1);
        expect(disks[0]?.freeSpace).toBe(1_234_567_890);
    });

    it('retries a read once on timeout, then succeeds', async () => {
        let calls = 0;
        const flaky = async () => {
            calls += 1;
            if (calls === 1) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
            return jsonResponse(STATUS);
        };
        const adapter = new RadarrAdapter(config, flaky as unknown as typeof fetch);

        expect(await adapter.getVersion()).toBe('5.14.0.9383');
        expect(calls).toBe(2);
    });

    it('gives up after exactly one retry — reads do not retry forever', async () => {
        let calls = 0;
        const alwaysTimeout = async () => {
            calls += 1;
            throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        };
        const adapter = new RadarrAdapter(config, alwaysTimeout as unknown as typeof fetch);

        await expect(adapter.getVersion()).rejects.toThrow(/timed out/);
        expect(calls).toBe(2);
    });

    it('does not retry a 401 — an auth failure is not transient', async () => {
        let calls = 0;
        const unauthorized = async () => {
            calls += 1;
            return jsonResponse({}, 401);
        };
        const adapter = new RadarrAdapter(config, unauthorized as unknown as typeof fetch);

        await expect(adapter.getVersion()).rejects.toThrow(/auth failed/);
        expect(calls).toBe(1);
    });

    it('opens the circuit after 5 consecutive failures and stops calling out', async () => {
        let calls = 0;
        const refuse = async () => {
            calls += 1;
            throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        };
        const adapter = new RadarrAdapter(config, refuse as unknown as typeof fetch);

        for (let i = 0; i < 5; i += 1) {
            await adapter.testConnection();
        }
        const callsAfterFive = calls;

        const d = await adapter.testConnection();
        expect(d.ok).toBe(false);
        expect(d.error?.detail).toMatch(/circuit/i);
        expect(calls).toBe(callsAfterFive); // no further network attempts
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run test/radarr.test.ts
```

Expected: FAIL — `Cannot find module '../src/services/radarr.ts'`.

- [ ] **Step 3: Write `src/services/types.ts`**

```ts
import type { ServiceId } from '../config/schema.ts';
import type { ServiceErrorKind } from '../core/errors.ts';

/**
 * A diagnosis, not a boolean (spec §6/§14). A connection test that returns
 * true/false tells the user nothing about what to fix.
 */
export type ConnectionDiagnosis = {
    ok: boolean;
    service: ServiceId;
    latency_ms: number;
    version?: string;
    error?: { kind: ServiceErrorKind; detail: string; remedy?: string };
};

export interface ServiceAdapter {
    readonly id: ServiceId;
    testConnection(): Promise<ConnectionDiagnosis>;
    getVersion(): Promise<string>;
}

export type DiskSpace = { path: string; label: string; freeSpace: number; totalSpace: number };
export type HealthCheck = { source: string; type: string; message: string };

/** Shared by Radarr and Sonarr; Sonarr's adapter lands in Phase 2. */
export interface ArrAdapter extends ServiceAdapter {
    getDiskSpace(): Promise<DiskSpace[]>;
    getFailedHealthChecks(): Promise<HealthCheck[]>;
}
```

- [ ] **Step 4: Write `src/services/radarr.ts`**

```ts
import type { ServiceConfig, ServiceId } from '../config/schema.ts';
import { ServiceError, classifyFetchError, classifyHttpStatus } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import type { ArrAdapter, ConnectionDiagnosis, DiskSpace, HealthCheck } from './types.ts';

/** Minimal hand-written shapes; replaced by generated types in Phase 2. */
type SystemStatus = { appName?: string; version?: string; instanceName?: string };

const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 60_000;

export class RadarrAdapter implements ArrAdapter {
    readonly id: ServiceId = 'radarr';

    #config: ServiceConfig;
    #fetch: typeof fetch;
    #consecutiveFailures = 0;
    #openedAt: number | undefined;

    constructor(config: ServiceConfig, fetchImpl: typeof fetch = fetch) {
        this.#config = config;
        this.#fetch = fetchImpl;
    }

    async getVersion(): Promise<string> {
        const status = await this.#get<SystemStatus>('/api/v3/system/status');
        if (!status.version) {
            throw new ServiceError('UpstreamError', this.id, 'system/status returned no version field');
        }
        return status.version;
    }

    async getDiskSpace(): Promise<DiskSpace[]> {
        return this.#get<DiskSpace[]>('/api/v3/diskspace');
    }

    async getFailedHealthChecks(): Promise<HealthCheck[]> {
        const all = await this.#get<HealthCheck[]>('/api/v3/health');
        // Radarr only returns entries worth surfacing, but it does include
        // `ok` rows in some versions — filter rather than trust.
        return all.filter(c => c.type !== 'ok');
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        const started = performance.now();
        try {
            const status = await this.#get<SystemStatus>('/api/v3/system/status');
            const diagnosis: ConnectionDiagnosis = {
                ok: true,
                service: this.id,
                latency_ms: Math.round(performance.now() - started)
            };
            if (status.version) diagnosis.version = status.version;
            return diagnosis;
        } catch (err) {
            const se =
                err instanceof ServiceError
                    ? err
                    : new ServiceError('UpstreamError', this.id, (err as Error).message ?? 'unknown');
            const error: ConnectionDiagnosis['error'] = { kind: se.kind, detail: se.detail };
            if (se.remedy !== undefined) error.remedy = se.remedy;
            return {
                ok: false,
                service: this.id,
                latency_ms: Math.round(performance.now() - started),
                error
            };
        }
    }

    // --- internals ---

    #circuitOpen(): boolean {
        if (this.#openedAt === undefined) return false;
        if (Date.now() - this.#openedAt >= CIRCUIT_COOLDOWN_MS) {
            // Half-open: allow a single trial request through.
            this.#openedAt = undefined;
            this.#consecutiveFailures = CIRCUIT_THRESHOLD - 1;
            return false;
        }
        return true;
    }

    #recordSuccess(): void {
        this.#consecutiveFailures = 0;
        this.#openedAt = undefined;
    }

    #recordFailure(): void {
        this.#consecutiveFailures += 1;
        if (this.#consecutiveFailures >= CIRCUIT_THRESHOLD && this.#openedAt === undefined) {
            this.#openedAt = Date.now();
            logger.warn({ service: this.id }, 'circuit breaker opened after consecutive failures');
        }
    }

    /** Reads retry once on timeout; writes never auto-retry (spec §15). */
    async #get<T>(path: string): Promise<T> {
        if (this.#circuitOpen()) {
            throw new ServiceError(
                'Unreachable',
                this.id,
                `circuit breaker is open after ${CIRCUIT_THRESHOLD} consecutive failures`,
                { remedy: `Not retried for ${CIRCUIT_COOLDOWN_MS / 1000}s. Fix the service, then try again.` }
            );
        }

        try {
            const result = await this.#attempt<T>(path);
            this.#recordSuccess();
            return result;
        } catch (err) {
            if (err instanceof ServiceError && err.kind === 'Timeout') {
                try {
                    const result = await this.#attempt<T>(path);
                    this.#recordSuccess();
                    return result;
                } catch (retryErr) {
                    this.#recordFailure();
                    throw retryErr;
                }
            }
            this.#recordFailure();
            throw err;
        }
    }

    async #attempt<T>(path: string): Promise<T> {
        const url = new URL(path, this.#config.url).toString();
        const signal = AbortSignal.timeout(this.#config.timeout_ms);

        let response: Response;
        try {
            response = await this.#fetch(url, {
                signal,
                headers: { 'X-Api-Key': this.#config.api_key, Accept: 'application/json' }
            });
        } catch (err) {
            throw classifyFetchError(err, this.id, url);
        }

        const httpError = classifyHttpStatus(response.status, this.id, url);
        if (httpError) throw httpError;

        try {
            return (await response.json()) as T;
        } catch (err) {
            throw new ServiceError('UpstreamError', this.id, `response from ${path} was not valid JSON`, {
                cause: err
            });
        }
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run test/radarr.test.ts
```

Expected: PASS — 11 tests.

- [ ] **Step 6: Commit**

```bash
git add src/services test/radarr.test.ts
git commit -m "feat: add Radarr adapter with diagnosing connection test and circuit breaker"
```

---

## Task 6: HTTP server — /healthz, bearer auth, and the MCP mount

**Files:**
- Create: `src/app.ts`, `src/index.ts`, `test/app.test.ts`

**Interfaces:**
- Consumes: `Config` from `src/config/schema.ts`; `loadConfig` from `src/config/load.ts`; `logger`; `ServiceAdapter` from `src/services/types.ts`; `registerStackHealth` from `src/tools/stackHealth.ts` — **write the throwaway stub given in Step 5 of this task; Task 7 replaces its body with the real tool.**
- Produces: `buildApp(opts: { config: Config; adapters: ServiceAdapter[] }): Hono` — a Hono app with `GET /healthz` open and `ALL /mcp` behind bearer auth.

- [ ] **Step 1: Write the failing tests**

```ts
// test/app.test.ts
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { ConfigSchema } from '../src/config/schema.ts';

const TOKEN = 'a'.repeat(64);

const config = ConfigSchema.parse({
    auth: { bearer_token: TOKEN },
    services: {}
});

const app = () => buildApp({ config, adapters: [] });

describe('GET /healthz', () => {
    it('is reachable without a token — it is a container probe, not an API', async () => {
        const res = await app().request('http://localhost:6060/healthz');
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ status: 'ok' });
    });
});

describe('bearer auth on /mcp', () => {
    it('rejects a request with no Authorization header', async () => {
        const res = await app().request('http://localhost:6060/mcp', { method: 'POST' });
        expect(res.status).toBe(401);
        expect(res.headers.get('WWW-Authenticate')).toMatch(/^Bearer/);
    });

    it('rejects a wrong token', async () => {
        const res = await app().request('http://localhost:6060/mcp', {
            method: 'POST',
            headers: { Authorization: `Bearer ${'b'.repeat(64)}` }
        });
        expect(res.status).toBe(401);
    });

    it('rejects a non-Bearer scheme', async () => {
        const res = await app().request('http://localhost:6060/mcp', {
            method: 'POST',
            headers: { Authorization: `Basic ${Buffer.from('u:p').toString('base64')}` }
        });
        expect(res.status).toBe(401);
    });

    it('does not leak whether the token was close — the body carries no token detail', async () => {
        const res = await app().request('http://localhost:6060/mcp', {
            method: 'POST',
            headers: { Authorization: `Bearer ${'b'.repeat(64)}` }
        });
        expect(await res.text()).not.toContain('b'.repeat(64));
    });

    it('accepts the configured token and reaches the MCP handler', async () => {
        const res = await app().request('http://localhost:6060/mcp', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${TOKEN}`,
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream'
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
        });

        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).toContain('stack_health');
    });
});

describe('the transport stays stateless', () => {
    it('never issues an Mcp-Session-Id header', async () => {
        const res = await app().request('http://localhost:6060/mcp', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${TOKEN}`,
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream'
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
        });
        expect(res.headers.get('Mcp-Session-Id')).toBeNull();
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run test/app.test.ts
```

Expected: FAIL — `Cannot find module '../src/app.ts'`.

- [ ] **Step 3: Write `src/app.ts`**

```ts
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import type { Context } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import type { Config } from './config/schema.ts';
import { logger } from './core/logger.ts';
import type { ServiceAdapter } from './services/types.ts';
import { registerStackHealth } from './tools/stackHealth.ts';

const NAME = 'arr-mcp';
const VERSION = process.env.ARR_MCP_VERSION ?? '0.0.0-dev';

/** Constant-time compare that does not leak length via early return. */
function tokenMatches(presented: string, expected: string): boolean {
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    if (a.length !== b.length) {
        // Still burn a comparison so timing does not distinguish
        // "wrong length" from "wrong bytes".
        timingSafeEqual(b, b);
        return false;
    }
    return timingSafeEqual(a, b);
}

export function buildApp(opts: { config: Config; adapters: ServiceAdapter[] }): ReturnType<typeof createMcpHonoApp> {
    const { config, adapters } = opts;

    // The factory runs once per request, so every call gets a fresh McpServer.
    // This is what keeps the transport stateless — do not hoist the server out.
    const handler = createMcpHandler(() => {
        const server = new McpServer({ name: NAME, version: VERSION });
        registerStackHealth(server, adapters);
        return server;
    });

    // Binding 0.0.0.0 in the container drops the SDK's default localhost
    // Host/Origin validation, so the allowed hosts must be named explicitly.
    const app = createMcpHonoApp({
        host: '0.0.0.0',
        allowedHosts: config.auth.allowed_hosts
    });

    app.get('/healthz', c => c.json({ status: 'ok', name: NAME, version: VERSION }));

    app.all('/mcp', async (c: Context) => {
        const header = c.req.header('Authorization') ?? '';
        const [scheme, presented] = header.split(' ');

        if (scheme !== 'Bearer' || !presented || !tokenMatches(presented, config.auth.bearer_token)) {
            logger.warn({ path: '/mcp', ip: c.req.header('x-forwarded-for') }, 'rejected unauthenticated MCP request');
            return c.json({ error: 'unauthorized' }, 401, {
                'WWW-Authenticate': 'Bearer realm="arr-mcp"'
            });
        }

        return handler.fetch(c.req.raw, { parsedBody: c.get('parsedBody') });
    });

    return app;
}
```

Two notes for the implementer:

- **Keep the `c: Context` annotation.** On an inferred callback context, `c.get`'s key parameter narrows to `never` and `c.get('parsedBody')` does not compile. This is documented SDK behaviour, not a workaround.
- **Binding `0.0.0.0` is what makes `allowedHosts` load-bearing.** The SDK's default `127.0.0.1` bind validates `Host`/`Origin` for free, but the container must bind all interfaces to be reachable on the LAN, which drops that default. `config.auth.allowed_hosts` (added in Task 2) is the replacement, and an empty list deliberately accepts any `Host` — a homelab user reaches this by IP, and there is no hostname to pin until they put a reverse proxy in front.

- [ ] **Step 4: Write `src/index.ts`**

```ts
import { serve } from '@hono/node-server';
import { buildApp } from './app.ts';
import { loadConfig } from './config/load.ts';
import { logger } from './core/logger.ts';
import { RadarrAdapter } from './services/radarr.ts';
import type { ServiceAdapter } from './services/types.ts';

const CONFIG_DIR = process.env.ARR_MCP_CONFIG_DIR ?? '/config';
const PORT = Number(process.env.ARR_MCP_PORT ?? 6060);

const { config, created } = await loadConfig(CONFIG_DIR);

if (created) {
    // The token is the only way in, and there is no UI until Phase 5, so it
    // must be discoverable from `docker logs` on first start.
    logger.info({ token: config.auth.bearer_token }, 'first run — use this bearer token for /mcp');
}

const adapters: ServiceAdapter[] = [];
if (config.services.radarr) {
    adapters.push(new RadarrAdapter(config.services.radarr));
}

serve({ fetch: buildApp({ config, adapters }).fetch, port: PORT, hostname: '0.0.0.0' }, info => {
    logger.info({ port: info.port, adapters: adapters.map(a => a.id) }, 'arr-mcp listening');
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Requires the Task 7 stub to exist. Create `src/tools/stackHealth.ts` with a minimal registration now — Task 7 replaces the body:

```ts
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { ServiceAdapter } from '../services/types.ts';

export function registerStackHealth(server: McpServer, _adapters: ServiceAdapter[]): void {
    server.registerTool(
        'stack_health',
        { description: 'placeholder', inputSchema: z.object({}) },
        async () => ({ content: [{ type: 'text', text: 'not implemented' }] })
    );
}
```

```bash
npx vitest run test/app.test.ts
```

Expected: PASS — 7 tests.

- [ ] **Step 6: Commit**

```bash
git add src/app.ts src/index.ts src/tools test/app.test.ts
git commit -m "feat: serve stateless MCP at /mcp behind required bearer auth"
```

---

## Task 7: `stack_health` tool

**Files:**
- Create: `test/stackHealth.test.ts`
- Modify: `src/tools/stackHealth.ts` (replace the Task 6 stub)

**Interfaces:**
- Consumes: `ServiceAdapter`, `ArrAdapter`, `ConnectionDiagnosis` from `src/services/types.ts`; `DetailSchema`, `LimitSchema`, `applyLimit` from `src/core/shape.ts`.
- Produces: `registerStackHealth(server: McpServer, adapters: ServiceAdapter[]): void`, registering a `stack_health` tool whose `structuredContent` matches `StackHealthResult`:
  `{ services: Array<{ service: ServiceId; ok: boolean; latency_ms: number; version?: string; error?: {...} }>; disks: { items: DiskSpace[]; total: number; returned: number; truncated: boolean }; failures: { items: HealthCheck[]; total: number; returned: number; truncated: boolean }; degraded: ServiceId[] }`

- [ ] **Step 1: Write the failing tests**

```ts
// test/stackHealth.test.ts
import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { buildStackHealth } from '../src/tools/stackHealth.ts';
import type { ArrAdapter, ConnectionDiagnosis, DiskSpace, HealthCheck } from '../src/services/types.ts';

function fakeArr(overrides: Partial<ArrAdapter> & { diagnosis: ConnectionDiagnosis }): ArrAdapter {
    return {
        id: 'radarr',
        testConnection: async () => overrides.diagnosis,
        getVersion: async () => overrides.diagnosis.version ?? '0',
        getDiskSpace: overrides.getDiskSpace ?? (async () => []),
        getFailedHealthChecks: overrides.getFailedHealthChecks ?? (async () => [])
    };
}

const healthy: ConnectionDiagnosis = { ok: true, service: 'radarr', latency_ms: 6, version: '5.14.0.9383' };
const broken: ConnectionDiagnosis = {
    ok: false,
    service: 'radarr',
    latency_ms: 3,
    error: { kind: 'Unreachable', detail: 'connection refused at 192.168.1.20:7878' }
};

describe('stack_health', () => {
    it('reports a healthy service with its version and latency', async () => {
        const result = await buildStackHealth([fakeArr({ diagnosis: healthy })], { detail: 'standard', limit: 50 });

        expect(result.services).toHaveLength(1);
        expect(result.services[0]).toMatchObject({ service: 'radarr', ok: true, version: '5.14.0.9383' });
        expect(result.degraded).toEqual([]);
    });

    it('degrades rather than failing when a service is down', async () => {
        const result = await buildStackHealth([fakeArr({ diagnosis: broken })], { detail: 'standard', limit: 50 });

        expect(result.degraded).toEqual(['radarr']);
        expect(result.services[0]?.ok).toBe(false);
        expect(result.services[0]?.error?.kind).toBe('Unreachable');
    });

    it('still returns what it gathered when one adapter throws outright', async () => {
        const exploding: ArrAdapter = {
            id: 'radarr',
            testConnection: async () => {
                throw new Error('unexpected');
            },
            getVersion: async () => '0',
            getDiskSpace: async () => [],
            getFailedHealthChecks: async () => []
        };
        const result = await buildStackHealth([exploding], { detail: 'standard', limit: 50 });

        expect(result.degraded).toEqual(['radarr']);
        expect(result.services[0]?.ok).toBe(false);
    });

    it('does not call disk or health endpoints on a service that is down', async () => {
        let diskCalls = 0;
        const adapter = fakeArr({
            diagnosis: broken,
            getDiskSpace: async () => {
                diskCalls += 1;
                return [];
            }
        });
        await buildStackHealth([adapter], { detail: 'standard', limit: 50 });

        expect(diskCalls).toBe(0);
    });

    it('honours the truncation contract on disks and failures', async () => {
        const disks: DiskSpace[] = Array.from({ length: 7 }, (_, i) => ({
            path: `/mnt/${i}`,
            label: `d${i}`,
            freeSpace: 1,
            totalSpace: 2
        }));
        const failures: HealthCheck[] = Array.from({ length: 4 }, (_, i) => ({
            source: `S${i}`,
            type: 'warning',
            message: 'm'
        }));

        const result = await buildStackHealth(
            [fakeArr({ diagnosis: healthy, getDiskSpace: async () => disks, getFailedHealthChecks: async () => failures })],
            { detail: 'standard', limit: 3 }
        );

        expect(result.disks).toMatchObject({ total: 7, returned: 3, truncated: true });
        expect(result.failures).toMatchObject({ total: 4, returned: 3, truncated: true });
    });

    it('omits disk detail at minimal but keeps the counts truthful', async () => {
        const disks: DiskSpace[] = [{ path: '/movies', label: 'movies', freeSpace: 1, totalSpace: 2 }];
        const result = await buildStackHealth([fakeArr({ diagnosis: healthy, getDiskSpace: async () => disks })], {
            detail: 'minimal',
            limit: 50
        });

        expect(result.disks.items).toEqual([]);
        expect(result.disks.total).toBe(1);
    });

    it('registers under the exact tool name stack_health', () => {
        const server = new McpServer({ name: 'test', version: '0.0.0' });
        expect(() => registerStackHealth(server, [])).not.toThrow();
    });
});
```

Add `import { registerStackHealth } from '../src/tools/stackHealth.ts';` to the imports.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run test/stackHealth.test.ts
```

Expected: FAIL — `buildStackHealth is not exported`.

- [ ] **Step 3: Write `src/tools/stackHealth.ts`**

```ts
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { ServiceId } from '../config/schema.ts';
import { ServiceError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import { DetailSchema, LimitSchema, applyLimit, type DetailLevel } from '../core/shape.ts';
import type { ArrAdapter, ConnectionDiagnosis, DiskSpace, HealthCheck, ServiceAdapter } from '../services/types.ts';

type Shaped<T> = { items: T[]; total: number; returned: number; truncated: boolean };

export type StackHealthResult = {
    services: ConnectionDiagnosis[];
    disks: Shaped<DiskSpace>;
    failures: Shaped<HealthCheck>;
    degraded: ServiceId[];
};

const isArr = (a: ServiceAdapter): a is ArrAdapter =>
    'getDiskSpace' in a && typeof (a as ArrAdapter).getDiskSpace === 'function';

/**
 * Composes per-service diagnoses into one answer. This tool must work
 * *especially* well when something is broken (spec §15) — a service that is
 * down contributes a diagnosis and a `degraded` entry, never an exception.
 */
export async function buildStackHealth(
    adapters: readonly ServiceAdapter[],
    opts: { detail: DetailLevel; limit: number }
): Promise<StackHealthResult> {
    const services: ConnectionDiagnosis[] = [];
    const degraded: ServiceId[] = [];
    const disks: DiskSpace[] = [];
    const failures: HealthCheck[] = [];

    await Promise.all(
        adapters.map(async adapter => {
            let diagnosis: ConnectionDiagnosis;
            try {
                diagnosis = await adapter.testConnection();
            } catch (err) {
                // testConnection should never throw, but a bug in one adapter
                // must not take down the whole answer.
                logger.error({ service: adapter.id, err }, 'testConnection threw; treating as degraded');
                diagnosis = {
                    ok: false,
                    service: adapter.id,
                    latency_ms: 0,
                    error: {
                        kind: err instanceof ServiceError ? err.kind : 'UpstreamError',
                        detail: err instanceof Error ? err.message : 'unknown error'
                    }
                };
            }

            services.push(diagnosis);
            if (!diagnosis.ok) {
                degraded.push(adapter.id);
                return; // do not hammer a service that just failed its probe
            }

            if (!isArr(adapter)) return;

            const [diskResult, healthResult] = await Promise.allSettled([
                adapter.getDiskSpace(),
                adapter.getFailedHealthChecks()
            ]);

            if (diskResult.status === 'fulfilled') {
                disks.push(...diskResult.value);
            } else {
                logger.warn({ service: adapter.id }, 'diskspace read failed');
                if (!degraded.includes(adapter.id)) degraded.push(adapter.id);
            }

            if (healthResult.status === 'fulfilled') {
                failures.push(...healthResult.value);
            } else {
                logger.warn({ service: adapter.id }, 'health read failed');
                if (!degraded.includes(adapter.id)) degraded.push(adapter.id);
            }
        })
    );

    // Order is not guaranteed by Promise.all's side effects above; sort so the
    // response is stable across calls and diffable in tests.
    services.sort((a, b) => a.service.localeCompare(b.service));
    degraded.sort();

    const shapedDisks = applyLimit(disks, opts.limit);
    const shapedFailures = applyLimit(failures, opts.limit);

    // `minimal` drops per-item payloads but keeps the counts honest: a model
    // must never see returned: 0 and conclude there are no disks.
    return {
        services,
        disks: opts.detail === 'minimal' ? { ...shapedDisks, items: [], returned: 0 } : shapedDisks,
        failures: shapedFailures,
        degraded
    };
}

export function registerStackHealth(server: McpServer, adapters: readonly ServiceAdapter[]): void {
    server.registerTool(
        'stack_health',
        {
            description:
                'Health of every configured service: version, disk space, failing health checks, and which services could not be reached. Returns partial results with a `degraded` list rather than failing when a service is down.',
            inputSchema: z.object({ detail: DetailSchema, limit: LimitSchema })
        },
        async ({ detail, limit }) => {
            const result = await buildStackHealth(adapters, { detail, limit });
            const summary =
                result.degraded.length === 0
                    ? `All ${result.services.length} configured service(s) healthy.`
                    : `${result.degraded.length} of ${result.services.length} service(s) degraded: ${result.degraded.join(', ')}.`;

            return {
                content: [{ type: 'text', text: summary }],
                structuredContent: result
            };
        }
    );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run test/stackHealth.test.ts && npm test
```

Expected: PASS — 7 new tests, and the whole suite green (the `app.test.ts` assertion that `tools/list` contains `stack_health` now hits the real tool).

- [ ] **Step 5: Commit**

```bash
git add src/tools/stackHealth.ts test/stackHealth.test.ts
git commit -m "feat: add stack_health tool that degrades instead of failing"
```

---

## Task 8: Container

**Files:**
- Create: `Dockerfile`, `docker-entrypoint.sh`, `.dockerignore`, `docker-compose.example.yml`
- Modify: `.github/workflows/ci.yml` (add `docker` to required contexts once green)

**Interfaces:**
- Consumes: `npm run build` producing `dist/`; `src/index.ts` reading `ARR_MCP_CONFIG_DIR` and `ARR_MCP_PORT`.
- Produces: an image exposing 6060, running as non-root with `PUID`/`PGID`, with a `/healthz` healthcheck.

- [ ] **Step 1: Write `.dockerignore`**

```
node_modules
dist
.git
.github
test
docs
config
*.log
```

- [ ] **Step 2: Write the `Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 needs a toolchain to compile its native addon.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends gosu wget \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 1000 arrmcp \
    && useradd -u 1000 -g arrmcp -d /app -s /usr/sbin/nologin arrmcp

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
    ARR_MCP_CONFIG_DIR=/config \
    ARR_MCP_PORT=6060 \
    PUID=1000 \
    PGID=1000
VOLUME ["/config"]
EXPOSE 6060

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:6060/healthz || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/src/index.js"]
```

Note: `dist/src/index.js` — with `rootDir: "."` and `include: ["src", "test"]`, `tsc` emits `dist/src/`. If the implementer changes `tsconfig.json` to `rootDir: "src"`, the path becomes `dist/index.js`; keep the two in sync and let the Task 9 smoke test catch a mismatch.

- [ ] **Step 3: Write `docker-entrypoint.sh`**

```sh
#!/bin/sh
set -e

# linuxserver-style PUID/PGID so the /config volume is writable by the host
# user who owns the bind mount.
PUID=${PUID:-1000}
PGID=${PGID:-1000}

if [ "$(id -u)" = "0" ]; then
    groupmod -o -g "$PGID" arrmcp 2>/dev/null || true
    usermod -o -u "$PUID" arrmcp 2>/dev/null || true
    mkdir -p "${ARR_MCP_CONFIG_DIR:-/config}"
    chown -R arrmcp:arrmcp "${ARR_MCP_CONFIG_DIR:-/config}"
    exec gosu arrmcp "$@"
fi

exec "$@"
```

- [ ] **Step 4: Write `docker-compose.example.yml`**

```yaml
services:
  arr-mcp:
    image: ghcr.io/bardesss/arr-mcp:latest
    container_name: arr-mcp
    ports: ['6060:6060']
    volumes: ['./config:/config']
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Europe/Amsterdam
    restart: unless-stopped
    healthcheck:
      test: ['CMD', 'wget', '-qO-', 'http://localhost:6060/healthz']
```

- [ ] **Step 5: Build the image and verify it runs**

```bash
docker build -t arr-mcp:dev .
docker run --rm -d --name arr-mcp-test -p 6060:6060 -v "$PWD/tmp-config:/config" arr-mcp:dev
sleep 5
curl -fsS http://localhost:6060/healthz
```

Expected: `{"status":"ok","name":"arr-mcp","version":"0.0.0-dev"}`.

- [ ] **Step 6: Verify the auth gate and the non-root user in the running container**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:6060/mcp
docker exec arr-mcp-test id -u
docker logs arr-mcp-test 2>&1 | grep -o 'first run' || true
```

Expected: `401`, then `1000` (not `0`), then `first run` present in the logs.

- [ ] **Step 7: Tear down and commit**

```bash
docker rm -f arr-mcp-test && rm -rf tmp-config
git add Dockerfile docker-entrypoint.sh .dockerignore docker-compose.example.yml
git commit -m "feat: add multi-stage non-root container with PUID/PGID and healthcheck"
```

- [ ] **Step 8: Add `docker` to the required status checks**

Now that it can pass:

```bash
gh api -X PATCH repos/bardesss/arr-mcp/branches/main/protection/required_status_checks \
  -f "contexts[]=check" -f "contexts[]=docker"
```

---

## Task 9: Release pipeline and nightly drift job

**Files:**
- Create: `.github/workflows/release.yml`, `.github/workflows/openapi-drift.yml`, `release-please-config.json`, `.release-please-manifest.json`

**Interfaces:**
- Consumes: a green `ci.yml`; the `Dockerfile` from Task 8.
- Produces: merging a release PR tags `vX.Y.Z` and publishes `ghcr.io/bardesss/arr-mcp` at `X.Y.Z`, `X.Y`, `X`, `latest`, plus `main` on every push to main, with an SBOM and a build-provenance attestation.

- [ ] **Step 1: Write the release-please config**

```json
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "packages": {
    ".": {
      "release-type": "node",
      "package-name": "arr-mcp",
      "changelog-path": "CHANGELOG.md",
      "bump-minor-pre-major": true,
      "draft": false,
      "prerelease": false
    }
  }
}
```

```json
{ ".": "0.0.0" }
```

`bump-minor-pre-major: true` keeps a breaking change on 0.x at a minor bump rather than jumping to 1.0.0 — the spec pins 1.0.0 to the end of phase 6, not to the first breaking change.

- [ ] **Step 2: Write `.github/workflows/release.yml`**

```yaml
name: Release

on:
  push:
    branches: [main]

permissions:
  contents: write
  pull-requests: write
  packages: write
  id-token: write
  attestations: write

jobs:
  release-please:
    runs-on: ubuntu-latest
    outputs:
      released: ${{ steps.rp.outputs.release_created }}
      tag: ${{ steps.rp.outputs.tag_name }}
      version: ${{ steps.rp.outputs.version }}
    steps:
      - uses: googleapis/release-please-action@v5
        id: rp
        with:
          config-file: release-please-config.json
          manifest-file: .release-please-manifest.json

  image:
    needs: release-please
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Compute tags
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/bardesss/arr-mcp
          # Stable releases get X.Y.Z / X.Y / X / latest; every main push gets `main`.
          tags: |
            type=raw,value=main,enable=${{ needs.release-please.outputs.released != 'true' }}
            type=semver,pattern={{version}},value=${{ needs.release-please.outputs.tag }},enable=${{ needs.release-please.outputs.released == 'true' }}
            type=semver,pattern={{major}}.{{minor}},value=${{ needs.release-please.outputs.tag }},enable=${{ needs.release-please.outputs.released == 'true' }}
            type=semver,pattern={{major}},value=${{ needs.release-please.outputs.tag }},enable=${{ needs.release-please.outputs.released == 'true' }}
            type=raw,value=latest,enable=${{ needs.release-please.outputs.released == 'true' }}

      - name: Build and push
        id: push
        uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          sbom: true
          provenance: mode=max
          build-args: |
            ARR_MCP_VERSION=${{ needs.release-please.outputs.version || 'main' }}

      - name: Attest build provenance
        uses: actions/attest-build-provenance@v2
        with:
          subject-name: ghcr.io/bardesss/arr-mcp
          subject-digest: ${{ steps.push.outputs.digest }}
          push-to-registry: true
```

Note: the `ARR_MCP_VERSION` build arg needs a matching `ARG ARR_MCP_VERSION` + `ENV ARR_MCP_VERSION=$ARR_MCP_VERSION` in the runtime stage of the `Dockerfile` so `/healthz` reports the real version. Add both when wiring this task.

- [ ] **Step 3: Write `.github/workflows/openapi-drift.yml`**

The highest-value automation in the spec (§18) and roughly twenty lines. Phase 1 has no vendored specs, so the job runs and reports "nothing to check" — the wiring exists so Phase 2 only adds URLs to the matrix.

```yaml
name: OpenAPI drift

on:
  schedule: [{ cron: '17 4 * * *' }]
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  refetch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - name: Re-fetch vendored specs
        run: |
          if [ ! -d specs ]; then
            echo "No vendored specs yet (Phase 2 adds them). Nothing to check."
            exit 0
          fi
          ./scripts/fetch-specs.sh
      - name: Open a PR if anything changed
        uses: peter-evans/create-pull-request@v7
        with:
          branch: chore/openapi-drift
          title: 'chore: upstream OpenAPI spec drift'
          body: |
            The nightly job re-fetched the vendored OpenAPI specs and found changes.
            Review the diff before merging — an upstream breaking change arrives
            here as a reviewable PR rather than a user's bug report.
          commit-message: 'chore: refresh vendored OpenAPI specs'
          delete-branch: true
```

- [ ] **Step 4: Verify the workflows parse**

```bash
gh workflow list 2>/dev/null || true
python -c "import yaml,sys; [yaml.safe_load(open(f)) for f in ['.github/workflows/ci.yml','.github/workflows/release.yml','.github/workflows/openapi-drift.yml']]; print('all workflows parse')"
```

Expected: `all workflows parse`.

- [ ] **Step 5: Commit and push through a PR**

This is the first real exercise of the branch protection from Task 1.

```bash
git checkout -b feat/release-pipeline
git add .github release-please-config.json .release-please-manifest.json Dockerfile
git commit -m "ci: add release-please, multi-arch GHCR publish, and nightly spec drift job"
git push -u origin feat/release-pipeline
gh pr create --fill
```

- [ ] **Step 6: Confirm CI gates the PR, then squash-merge**

```bash
gh pr checks --watch
gh pr merge --squash --delete-branch
```

Expected: `check` and `docker` both pass; the merge is a squash and `main` stays linear.

- [ ] **Step 7: Verify release-please opened a release PR**

```bash
gh pr list --label 'autorelease: pending'
```

Expected: one open PR titled `chore(main): release 0.1.0`.

---

## Task 10: End-to-end verification against a real stack

The spec's Phase 1 done-criteria are all *observed behaviours*, not code. This task is where they get observed. Nothing here is optional — a walking skeleton that has never walked is not done.

**Files:**
- Modify: `README.md` (add the verified quick-start), `docs/superpowers/specs/2026-08-04-arr-mcp-design.md` (record the §21 answers)

**Interfaces:**
- Consumes: everything above.
- Produces: a verified 0.1.0 release and a spec whose open questions are answered.

- [ ] **Step 1: Run the container against real Radarr**

```bash
mkdir -p ~/arr-mcp-config
docker run --rm -d --name arr-mcp -p 6060:6060 -v ~/arr-mcp-config:/config ghcr.io/bardesss/arr-mcp:main
docker logs arr-mcp 2>&1 | grep 'first run'
```

Copy the token, then add Radarr to `~/arr-mcp-config/config.yaml`:

```yaml
auth:
  bearer_token: <the token from the logs>
  allowed_hosts: []
services:
  radarr:
    url: http://192.168.1.20:7878
    api_key: <your Radarr API key>
```

Restart: `docker restart arr-mcp`.

- [ ] **Step 2: Confirm the Radarr response shapes match the Task 5 fixtures**

This closes the fixture caveat from Task 5 Step 1 and answers part of spec §21.2.

```bash
KEY=<your Radarr API key>
curl -s -H "X-Api-Key: $KEY" http://192.168.1.20:7878/api/v3/system/status | python -m json.tool | head -20
curl -s -H "X-Api-Key: $KEY" http://192.168.1.20:7878/api/v3/diskspace | python -m json.tool | head -20
curl -s -H "X-Api-Key: $KEY" http://192.168.1.20:7878/api/v3/health | python -m json.tool | head -20
```

If any field name differs from the fixtures in `test/radarr.test.ts`, fix the fixture and the corresponding type in `src/services/radarr.ts` together, re-run `npm test`, and commit as `fix:`.

While here, capture one movie for Phase 2's benefit and record the `ratings` shape in the spec — this is spec §21.2's actual question:

```bash
curl -s -H "X-Api-Key: $KEY" 'http://192.168.1.20:7878/api/v3/movie?pageSize=1' \
  | python -c "import json,sys; m=json.load(sys.stdin); print(json.dumps(m[0].get('ratings'), indent=2))"
```

- [ ] **Step 3: Verify the unauthenticated request is rejected**

```bash
curl -s -o /dev/null -w 'no token: %{http_code}\n' -X POST http://localhost:6060/mcp
curl -s -o /dev/null -w 'bad token: %{http_code}\n' -X POST http://localhost:6060/mcp -H 'Authorization: Bearer wrong'
```

Expected: `no token: 401` and `bad token: 401`.

- [ ] **Step 4: Call `stack_health` over the real MCP transport**

```bash
TOKEN=<the token>
curl -s -X POST http://localhost:6060/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"stack_health","arguments":{}}}'
```

Expected: an SSE `message` event whose `structuredContent` shows `services[0].ok: true`, a real Radarr `version`, populated `disks`, and `degraded: []`.

- [ ] **Step 5: Verify it degrades rather than failing**

Point `services.radarr.url` at a dead port (`http://192.168.1.20:9999`), restart, and repeat Step 4.

Expected: HTTP 200 with `degraded: ["radarr"]` and an `Unreachable` error carrying a remedy — **not** a 500 and not a stack trace. Restore the real URL afterwards.

- [ ] **Step 6: Verify with a real MCP client**

Add to a client's MCP config (Claude Code shown; any 2026-07-28-capable client works):

```bash
claude mcp add --transport http arr-mcp http://localhost:6060/mcp \
  --header "Authorization: Bearer $TOKEN"
```

Then ask it: *"Use stack_health to tell me if my media stack is healthy."* Confirm the model reports the real Radarr version and disk figures.

- [ ] **Step 7: Record the resolved spec questions**

Edit `docs/superpowers/specs/2026-08-04-arr-mcp-design.md` §21: mark item 5 resolved (SDK v2 ships 2026-07-28 support; `createMcpHandler` is the entry point), item 2 resolved with the observed `ratings` shape from Step 2, and leave items 1, 3, 4, and 6 for their phases. Note item 6's partial finding about the legacy MRTR shim.

- [ ] **Step 8: Commit and ship 0.1.0**

```bash
git add README.md docs test src
git commit -m "docs: record verified Radarr shapes and resolved SDK question"
git push
```

Then merge the release-please PR:

```bash
gh pr merge "$(gh pr list --label 'autorelease: pending' --json number --jq '.[0].number')" --squash
```

- [ ] **Step 9: Verify the published image is what Phase 1 promised**

```bash
gh release view v0.1.0
docker pull ghcr.io/bardesss/arr-mcp:0.1.0
gh attestation verify oci://ghcr.io/bardesss/arr-mcp:0.1.0 --owner bardesss
docker run --rm -d --name arr-mcp-rel -p 6061:6060 -v ~/arr-mcp-config:/config ghcr.io/bardesss/arr-mcp:0.1.0
sleep 5 && curl -fsS http://localhost:6061/healthz && docker rm -f arr-mcp-rel
```

Expected: the release exists, the tagged image pulls, provenance verifies, and `/healthz` reports version `0.1.0` — not `0.0.0-dev`. A version mismatch here means the `ARR_MCP_VERSION` build arg is not reaching the runtime stage (Task 9 Step 2's note).

---

## Phase 1 Done Criteria

Straight from spec §20, each mapped to where it is observed:

| Criterion | Verified in |
|---|---|
| A real MCP client calls `stack_health` against real Radarr | Task 10 Steps 4, 6 |
| …in Docker | Task 10 Step 1 |
| …green in CI | Task 9 Step 6 |
| An unauthenticated request is rejected | Task 10 Step 3 (and `test/app.test.ts`) |
| Merging a release PR publishes a tagged image | Task 10 Steps 8, 9 |
| §18 repo setup established before there is history | Task 1 Step 14, Task 9 |

## Deferred To Later Phases (explicitly not Phase 1)

So a reviewer does not flag these as gaps: the remaining seven adapters, recorded fixtures and contract tests, the identity resolver and `diagnose`, all 19 other tools, permission-tier enforcement and the write audit, MRTR confirmation, §11 content fencing, the config UI, the IMDb dataset, resources and prompts, and the SQLite log/audit store. `better-sqlite3` is a declared dependency in Phase 1 only so the native-build stage of the Dockerfile is proven early.

Three narrower omissions worth naming, because each is something the spec asks for and Phase 1 does *not* deliver:

- **Config hot-reload (§13).** Phase 1 reads `config.yaml` once at startup; editing it requires `docker restart`. Hot-reload matters when the UI is writing the file (Phase 5), and a file watcher added now would be untested plumbing. Phase 5 owns it. Until then the README must say "restart after editing config.yaml" rather than implying otherwise.
- **The token-budget assertion in CI (§17/§18).** The spec's PR checks include asserting each serialised tool response stays under a token budget. With one tool returning a handful of fields there is nothing meaningful to bound; the assertion belongs with Phase 2's read tools, where response size becomes a real risk.
- **Per-service `timeout_ms` is configurable but the circuit-breaker constants are not.** `CIRCUIT_THRESHOLD` and `CIRCUIT_COOLDOWN_MS` are module constants matching the spec's stated 5 / 60 s. Promote them to config only if a real deployment needs it.
