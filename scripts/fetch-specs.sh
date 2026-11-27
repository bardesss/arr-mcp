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
# Whisparr's document declares `info.version: "3.0.0"` while describing the V2,
# series-shaped API — `/series` and `/episode`, no `/movie`. It is not Eros,
# whose repo split off to Whisparr/Whisparr-Eros and is a separate service id.
# It is fetched from the latest release rather than from the branch, because
# Whisparr/Whisparr#1301 deleted the in-tree copy and now publishes the document
# as a release asset. `releases/latest/download` resolves to the newest
# non-prerelease, so the document still tracks upstream and still drifts; a
# pinned tag, as Grimmory's below is, would never report a change again.
#
# Grimmory's is a release asset pinned to the tested tag, as Profilarr's is.
# Both redirect to objects.githubusercontent.com, which the curl -L below
# follows.
#
# Keep this list free of blank lines and `#` comments: every line is parsed as
# an entry. Entries that are not a `name url` pair are skipped and counted as
# failures below, rather than being fetched as if the text were a URL.
SERVICES="
radarr https://raw.githubusercontent.com/Radarr/Radarr/develop/src/Radarr.Api.V3/openapi.json
sonarr https://raw.githubusercontent.com/Sonarr/Sonarr/develop/src/Sonarr.Api.V3/openapi.json
whisparr https://github.com/Whisparr/Whisparr/releases/latest/download/openapi.json
lidarr https://raw.githubusercontent.com/Lidarr/Lidarr/develop/src/Lidarr.Api.V1/openapi.json
prowlarr https://raw.githubusercontent.com/Prowlarr/Prowlarr/develop/src/Prowlarr.Api.V1/openapi.json
jellyfin https://api.jellyfin.org/openapi/jellyfin-openapi-stable.json
seerr https://raw.githubusercontent.com/seerr-team/seerr/develop/seerr-api.yml
profilarr https://raw.githubusercontent.com/Dictionarry-Hub/profilarr/v2.2.0/src/lib/api/v1.openapi.json
grimmory https://github.com/grimmory-tools/grimmory/releases/download/v3.5.0/openapi.json
"

# Trapped rather than removed at the end of the loop: `set -e` means a failed
# curl or a spec that will not parse exits from inside the loop, and the `rm`
# below never runs.
#
# `if`, not `[ -n "$tmp" ] && rm`: bash takes the EXIT trap's status as the
# script's, and that `&&` returns 1 whenever `tmp` is empty, which is every
# clean run. And the loop reads a here-string rather than a pipe, so the `tmp`
# it assigns is visible out here for the trap to act on at all.
tmp=""
cleanup() {
  if [ -n "$tmp" ]; then rm -f "$tmp"; fi
}
trap cleanup EXIT

# One unreachable URL used to end the run, because `set -e` exits from inside
# the loop. That is how Whisparr moving its document hid seventy-two days of
# drift in the other eight: the fetch step died third, and the codegen, contract
# and typecheck steps after it never ran at all. Failures are collected instead,
# and reported together at the end with a non-zero exit, so one upstream move
# costs that service's entry and nothing else.
failed=""

while read -r name url; do
  [ -z "$name" ] && continue
  if [ -z "$url" ]; then
    echo "skipping malformed entry: ${name}" >&2
    failed="${failed} ${name}"
    continue
  fi
  echo "fetching ${name} <- ${url}"
  tmp="$(mktemp)"
  if ! curl -fsSL "$url" -o "$tmp"; then
    echo "  could not fetch ${name} from ${url}" >&2
    failed="${failed} ${name}"
    rm -f "$tmp"
    tmp=""
    continue
  fi

  # Normalise to formatted JSON regardless of whether upstream serves JSON or
  # YAML, so the nightly diff shows semantic changes rather than reflow noise.
  # A document that parses as neither is a failure for this service alone, for
  # the same reason an unreachable one is: the existing specs/<name>.json is
  # left untouched rather than half-written.
  if ! node -e '
    const { readFileSync, writeFileSync } = require("node:fs");
    const raw = readFileSync(process.argv[1], "utf8");
    let doc;
    try { doc = JSON.parse(raw); }
    catch { doc = require("yaml").parse(raw); }
    writeFileSync(process.argv[2], JSON.stringify(doc, null, 2) + "\n");
  ' "$tmp" "specs/${name}.json"; then
    echo "  could not parse ${name}'s document as JSON or YAML" >&2
    failed="${failed} ${name}"
  fi
  rm -f "$tmp"
  # Cleared so the trap does not chase a path this iteration already removed.
  tmp=""
done <<< "$SERVICES"

if [ -n "$failed" ]; then
  echo "failed:${failed}" >&2
  echo "every other spec was refreshed; review the diff in specs/" >&2
  exit 1
fi

echo "done — review the diff in specs/ before committing"
