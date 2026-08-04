# Contributing

## You do not need a media stack

Every test runs against injected `fetch` mocks and recorded fixtures. CI never
touches a live service, and neither do you for normal development:

```bash
npm install
npm test
```

An optional integration script for maintainers with a real stack lives under
`scripts/` (from 0.2 onwards).

## The three gates

CI runs exactly what you can run locally. Please make all three pass before
opening a PR:

```bash
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
npm test           # vitest
```

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/) — release-please
reads them to decide the next version and to write `CHANGELOG.md`.

| Prefix | Effect on version |
| --- | --- |
| `fix:` | patch |
| `feat:` | minor |
| `feat!:` or a `BREAKING CHANGE:` footer | minor while on 0.x, major after 1.0 |
| `chore:`, `docs:`, `ci:`, `test:`, `refactor:` | none |

## The tool surface is the public API

Renaming a tool or removing a parameter breaks every user's saved prompts and
agent configuration, and it breaks **silently** — the model stops finding the
tool rather than raising an error. Changes to tool names or parameters therefore
get stricter review than ordinary refactors. After 1.0, a renamed tool keeps its
old name as an alias for one full minor, with the deprecation stated in the
tool's own description text.

Tool count is a hard constraint, not a preference: model accuracy degrades
measurably past roughly 40 tools. New capability should extend an existing tool
before it adds one.

## Adding a service adapter

The highest-value contribution, and deliberately self-contained. The contract
lives in [`src/services/types.ts`](src/services/types.ts) and
[`src/services/radarr.ts`](src/services/radarr.ts) is the reference
implementation — read those two files and you have everything you need.

An adapter must:

- implement `ServiceAdapter` (`id`, `testConnection`, `getVersion`)
- return a `ConnectionDiagnosis` from `testConnection`, **never a boolean** — it
  distinguishes DNS failure, connection refused, TLS error, 401, 404 and
  version-too-old, and states the remedy
- map every failure onto the error taxonomy in `src/core/errors.ts`
- accept an injectable `fetch` so it is testable without the service
- ship recorded fixtures covering success and each error mode

Three of the eight services publish no usable OpenAPI spec, so the adapter
interface is defined by us and must stay hand-writable. Code generation is an
implementation detail inside an adapter, never the shape of the contract.

## Reporting a bug

Please include service versions, your arr-mcp version, and redacted logs.
Redact API keys and the bearer token.
