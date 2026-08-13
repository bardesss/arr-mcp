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
                   →  server.json → registry.modelcontextprotocol.io
```

Image tags are `X.Y.Z`, `X.Y`, `X` and `latest` for releases, plus `main` for
bleeding edge. Nothing else. The release workflow fails the job when a release
computes no version tag — a release that publishes only `latest` is a silent
policy violation, and it has happened once.

## The MCP Registry entry

`server.json` is the listing at `registry.modelcontextprotocol.io`, which is how
MCP clients discover this server. The `registry` job publishes it after the
image, on releases only, using the workflow's own OIDC identity — there is no
token to store or rotate.

Two things it depends on, both of which fail late:

- **The published image must carry `LABEL io.modelcontextprotocol.server.name`
  matching the `name` in `server.json`.** That label is the registry's only
  proof we own `ghcr.io/bardesss/arr-mcp`, and it is read from the image at
  publish time — so the tag must already be pushed, which is why `registry`
  needs `image`.
- **The tag in `packages[0].identifier` must be the one the release pushed.**
  release-please bumps `version`, but cannot rewrite a tag embedded in a string,
  so the job derives both from the release version with `jq`.

Check a `server.json` change without publishing anything:

```bash
mcp-publisher validate server.json
```

It checks the schema and the registry's rules. It does **not** check the image
label — that only fails during a real publish.

## Forcing a version, and the three ways it has gone wrong

`CONTRIBUTING.md` reserves minors for roadmap phases. **The `Release-As` footer
goes on the phase's last commit, in the phase PR itself** — not in a follow-up,
and not conditional on anything.

The temptation is to withhold it when a phase ends with verification that needs
a live stack. That reasoning is wrong here: phase features are off by default or
additive, pre-1.0 patches are cheap, and the README has *already published* what
the number means — so shipping a phase under a patch number leaves the tags and
the docs permanently disagreeing. **Cut the version, then run the gate.**
Anything it finds is a patch.

It has still gone wrong three times, in three different ways:

| What happened | Result |
| --- | --- |
| Footer withheld pending verification (0.8) | Proposed `0.7.4` |
| Same again (0.9) | Proposed `0.8.1` |
| Footer present four times, **eaten by the squash** (1.0) | Proposed `0.9.1` |

The third is the subtle one. **Squashing concatenates every commit body into one
message**, so a footer that was the last line of the last commit ends up in the
*middle* of the squashed body — and release-please only honours `Release-As:` as
a trailing footer. Having it four times over made no difference.

So when a version is being forced, either merge **without** squashing, or set
the squash message yourself:

```bash
gh pr merge <n> --squash --body "$(printf 'summary line

Release-As: 1.0.0')"
```

If it is missed anyway, the repair is a follow-up commit carrying the footer,
which makes the open release PR re-cut itself.

**The squash subject decides the bump.** A branch holding both a `feat:` and a
`fix:` squashes to whichever commit's subject GitHub picks — usually the first —
and release-please reads only that. A feature merged behind a fix ships as a
patch, silently. Set `--subject` when a branch mixes types:

```bash
gh pr merge <n> --squash --subject 'feat: what it adds (#83)'
```

Both traps are the same shape: **squashing flattens the message, and only the
flattened message is read.** Footers stop being footers; subjects other than the
first stop existing.

**Read the version on the release PR title before merging it**, every time. It
is far cheaper to notice there than after the tag exists.

## If the release PR is BLOCKED with nothing failing

`main` requires the `check` and `docker` status checks, with `enforce_admins:
true` — so nobody merges without them, including you. If the release PR shows
`mergeable: MERGEABLE` but `mergeStateStatus: BLOCKED`, and its checks section
is **empty rather than red**, the runs are waiting for approval:

```bash
gh run list --branch release-please--branches--main--components--arr-mcp
```

A column of `action_required` runs at `0s` confirms it — queued, never started.
Approve the newest one in the Actions tab, or:

```bash
gh api repos/bardesss/arr-mcp/actions/runs/<id>/approve --method POST
```

Approve it **after** the last feature PR merges. Every merge makes
release-please push again, which supersedes the run you just approved.

This gated 0.4.0 and 0.5.0 — fourteen zero-second runs between them, and both
releases only merged because one run was approved by hand.

### What is actually known, and what is not

The mechanism is clear: `release.yml` called release-please without a `token:`,
so it fell back to `GITHUB_TOKEN` and opened the PR as `app/github-actions`,
whose workflow runs land in `action_required`.

What is **not** explained is why the gate came and went:

```
0.3.0, 0.3.1   success ~1m          no gate at all
0.4.0          11 × action_required 0s, then success once approved
0.5.0           3 × action_required 0s, then success once approved
0.5.1          success 50s          no gated run, nothing approved
```

0.5.1's CI ran unassisted at 12:11 on 2026-08-06 — **before** the
`RELEASE_PLEASE_TOKEN` secret existed (12:29) and before the `token:` line
merged (12:31). So the approval state had already cleared on its own, most
likely because approving a run stops GitHub gating that actor. Neither the
switch-on around 2026-08-05 17:47 nor the switch-off is visible in any API this
project can query.

**Treat the token as insurance, not a proven cure.** It removes the dependency
on an approval state nobody can see or explain, and it is inert otherwise:
`${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}` changes nothing
when the secret is absent, because an unset secret is the empty string. It has
never been observed fixing a gated release, because no release has been gated
since it landed.

The `gh run list` check above is the part that has actually earned its place —
it turns "the release PR is mysteriously stuck" into a one-command answer.

### Maintaining the secret

It is a fine-grained PAT scoped to this repository, with **Contents:
read/write** and **Pull requests: read/write**. Fine-grained PATs expire, and
when this one does the `||` fallback quietly reverts to `GITHUB_TOKEN` — no
error, just the old symptom possibly returning. To replace it:

```bash
gh secret set RELEASE_PLEASE_TOKEN --repo bardesss/arr-mcp   # paste at the prompt
```

Set it interactively, never as a shell argument — an argument lands in shell
history.

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

It also renders every config UI page against the live stack, signs in, and
asserts that no API key reaches the configuration form. Those cases are
read-only and never save, so running the script cannot change your
configuration — and since 0.6 it never writes to `config.yaml` at all
(`loadConfig(dir, { persist: false })`). Before that it silently backfilled a
generated password into a real config, one that nothing ever printed.

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

- [x] [MCP registry](https://github.com/modelcontextprotocol/registry) listing —
      `io.github.bardesss/arr-mcp`, published from `server.json` by the release
      workflow
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
