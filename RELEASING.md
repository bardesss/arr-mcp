# Releasing

## Mechanics

Conventional Commits drive release-please, which keeps a release PR open
against `main`. Merging that PR tags the version, publishes the GitHub release,
and pushes multi-arch images to GHCR with an SBOM and build provenance.

```
PR merged to main  →  release-please updates its release PR
merge release PR   →  tag vX.Y.Z + GitHub Release
tag                →  buildx multi-arch → ghcr.io/bardesss/arr-mcp
                   →  SBOM + provenance attestation
```

Image tags are `X.Y.Z`, `X.Y`, `X` and `latest` for releases, plus `main` for
bleeding edge. Nothing else. The release workflow fails the job when a release
computes no version tag — a release that publishes only `latest` is a silent
policy violation, and it has happened once.

## Check `main` contains what you think it does

**Before merging the release PR.** A release PR describes the commits on `main`
right now — not the branch you were working on, and not a fix pushed to that
branch after its PR merged.

```bash
git fetch origin
git log --oneline origin/main -10
```

Read the list against what you believe the release contains. Anything missing
is missing from the release.

This is not hypothetical. **0.3.0 shipped without seven adapter fixes** — a
crash in `get_subtitles`, ratings reporting a source called `votes` worth
164018, Jellyfin search returning no external ids at all. The fixes existed,
were tested, and were pushed to the feature branch about a minute after its PR
was merged. The branch had them; `main` did not; the release went out anyway.

Two habits prevent it:

- **A green PR is not a merged PR.** "Pushed and CI is green" and "this is on
  `main`" are different claims. Check the second one.
- **Force-push before merging a stacked branch.** When PRs are stacked, merging
  the lower one squashes its commits, and any commit added to the upper branch
  afterwards needs a rebase before it can land.

## Every release updates the README

**This is not optional and it is not a follow-up.** The README is the only
thing most people read, and a stale one is worse than none: it told users there
was no published image for two releases after there was.

Before merging the release PR, check every one of these and fix what has
drifted:

- [ ] **Status callout** — names the version being cut and describes what it
      actually does, not what the previous one did
- [ ] **Quick start** — the pinned image tag exists, and the instructions work
      start to finish for someone who has never run it
- [ ] **Roadmap table** — versions match reality, including any that shifted
- [ ] **Tool list** — every tool the release exposes, and nothing it does not
- [ ] **Forward references** — "lands in 0.x" claims still point at the right
      version

A phase that ships without its README change is not finished.

## Verify before announcing

- [ ] `git log --oneline origin/main` contains everything you think the release does
- [ ] `docker run` the published tag against a real stack, not just the build
- [ ] `npm run integration` — calls every tool against a real stack and fails
      if any tool has no case at all
- [ ] `/healthz` responds, and an unauthenticated `/mcp` request is rejected

Calling every tool matters more than it sounds. Adapters are tested against
recorded fixtures, which prove the mapping and nothing else. Every defect that
reached 0.3.0 — a null field crashing a tool, a query parameter that has to be
asked for, an endpoint that answers 400 — was invisible to 396 passing tests
and obvious within seconds of a real call.

`npm run integration` is the mechanical form of "call every tool". It fails
when `TOOL_NAMES` gains a tool no case covers, so a new tool cannot ship
uncalled — which is exactly how 0.3.0 shipped a `get_subtitles` that crashed
on the first real request.

## Recapture fixtures when an adapter starts reading a new endpoint

`test/fixtures/` is what the contract tests check against, so an endpoint with
no fixture has no guard at all. Add it to `ENDPOINTS` in
`scripts/capture-fixtures.ts`, run `npm run capture`, and reconcile the adapter
against what actually comes back.

Skipping this for the ten Phase 2b tools is what put seven defects in a
release. The same gate, followed properly one phase earlier, caught a bug that
reported a 23-hour-stale library as scanned a minute ago.

## Distribution

Do this at **0.3 and later**, not for 0.1 or 0.2 — those are foundations, and
an announcement lands once.

- [ ] [MCP registry](https://github.com/modelcontextprotocol/registry) listing
- [ ] Unraid Community Applications template
- [ ] Umbrel app store submission
- [ ] CasaOS app store submission
- [ ] r/selfhosted post — lead with the differentiator, not the feature list:
      one server for the whole stack, a config page that diagnoses instead of
      printing pass/fail, and tool output treated as untrusted data
- [ ] Link the release in the README's status callout

Lead every listing with what no comparable project does. Fourteen of them
exist; none ships a config UI and none addresses untrusted tool content.
Discovery, not capability, is the binding constraint here — the unmaintained
project this one succeeds still leads the field on stars.
