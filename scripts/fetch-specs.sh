#!/usr/bin/env bash
# Re-fetches the vendored OpenAPI documents. Run by `npm run specs:fetch` and
# nightly by .github/workflows/openapi-drift.yml, which opens a PR when the
# output changes — so an upstream breaking change arrives as a reviewable diff
# rather than as a user's bug report (design spec §18).
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p specs

# Seerr's location was design spec §21.3's open question: it carries Overseerr's
# spec forward as `seerr-api.yml` on `develop`, and it is YAML rather than JSON —
# which is why the normalisation step below is not optional.
SERVICES="
radarr https://raw.githubusercontent.com/Radarr/Radarr/develop/src/Radarr.Api.V3/openapi.json
sonarr https://raw.githubusercontent.com/Sonarr/Sonarr/develop/src/Sonarr.Api.V3/openapi.json
prowlarr https://raw.githubusercontent.com/Prowlarr/Prowlarr/develop/src/Prowlarr.Api.V1/openapi.json
jellyfin https://api.jellyfin.org/openapi/jellyfin-openapi-stable.json
seerr https://raw.githubusercontent.com/seerr-team/seerr/develop/seerr-api.yml
"

echo "$SERVICES" | while read -r name url; do
  [ -z "$name" ] && continue
  echo "fetching ${name} <- ${url}"
  tmp="$(mktemp)"
  curl -fsSL "$url" -o "$tmp"

  # Normalise to formatted JSON regardless of whether upstream serves JSON or
  # YAML, so the nightly diff shows semantic changes rather than reflow noise.
  node -e '
    const { readFileSync, writeFileSync } = require("node:fs");
    const raw = readFileSync(process.argv[1], "utf8");
    let doc;
    try { doc = JSON.parse(raw); }
    catch { doc = require("yaml").parse(raw); }
    writeFileSync(process.argv[2], JSON.stringify(doc, null, 2) + "\n");
  ' "$tmp" "specs/${name}.json"
  rm -f "$tmp"
done

echo "done — review the diff in specs/ before committing"
