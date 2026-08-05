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

- [ ] `docker run` the published tag against a real stack, not just the build
- [ ] An MCP client lists the expected tool count and calls one successfully
- [ ] `/healthz` responds, and an unauthenticated `/mcp` request is rejected
