# Vendored OpenAPI specs

Fetched by `scripts/fetch-specs.sh`, regenerated into `src/services/generated/`
by `npm run codegen`, and refreshed as a pair by the nightly
`openapi-drift.yml` job. Do not edit them by hand.

**`whisparr.json` declares `info.version: "3.0.0"` but describes Whisparr V2.**
It has `/series` and `/episode` and no `/movie`. Whisparr V3 ("Eros") is a
Radarr fork with a different API and is not covered here.
