# Fork divergences

This repository is a fork of [useplunk/plunk](https://github.com/useplunk/plunk) (AGPL-3.0). This file lists every
**divergence**: each change that makes this fork differ from upstream `next`. A pull request that adds, changes or
removes a divergence updates this file in the same pull request.

## Base

- **Upstream:** [useplunk/plunk](https://github.com/useplunk/plunk), branch `next`
- **Merge base:** `17e840b6d039af8b85217ed8c1de3267b75fd615` (`v0.15.0` plus "feat: Add automatic conversion to
  text/plain")
- **Fork created:** 2026-09-23. No upstream sync since.

## Policy

- **No database schema changes.** The fork never changes `packages/db/prisma/` (no Prisma migrations, no schema edits),
  so the only migrations a fork image applies on start are upstream's own.
- **Upstream behavior by default.** New options and settings default to what upstream does today.
- **Upstream first where it fits.** Divergences that are useful to every Plunk deployment are proposed upstream; each
  records its upstream status, and a divergence is removed once upstream ships it.

## Format

Each divergence is a `### Dnn — title` section below. IDs are never reused. Each section has these bullets:

- **Since:** date the divergence was first merged into the fork.
- **Kind:** `feature`, `fix`, `docs` or `ci`.
- **Upstream:** `fork-only`, `not proposed`, or a link to the upstream pull request or issue with its state.
- **Files:** one backticked path per nested bullet: an exact path, or a directory prefix ending in `/` for a directory
  the fork adds (changes inside upstream directories are listed file by file). Deleted files and the old path of a
  renamed file are listed too. A path may appear under more than one divergence.
- **What**, **Why** (optional) and **Remove when**.

The divergence audit (D02) reads the **Files** lists and the workflow inventory mechanically; keep them in this format.
It skips HTML comments and fenced code blocks.

## Divergences

### D01 — Fork notice and divergence log

- **Since:** 2026-09-24
- **Kind:** docs
- **Upstream:** fork-only
- **Files:**
  - `README.md`
  - `FORK.md`
  - `CLAUDE.md`
- **What:** a notice at the top of `README.md` linking to this file; this file; an instruction in `CLAUDE.md` that
  every divergence is recorded here and that the fork never changes the database schema.
- **Remove when:** never (fork-only).

### D02 — Fork checks in CI

- **Since:** 2026-09-24
- **Kind:** ci
- **Upstream:** fork-only
- **Files:**
  - `.github/workflows/fork-checks.yml`
  - `scripts/fork/`
- **What:** the `Fork checks` workflow runs on every push and pull request to `next`.
  - **Divergence audit** (`node scripts/fork/audit-divergence.mjs`): every file that differs from the merge base with
    upstream `next` must be listed under a divergence, every listed path must still differ, a directory entry may only
    name a directory the fork adds, nothing under `packages/db/prisma/` may change, and every workflow file must be in
    the workflow inventory with the state it has in this repository's Actions settings. Run it locally with
    `FORK_AUDIT_UPSTREAM_REF=upstream/next node scripts/fork/audit-divergence.mjs --working-tree` after
    `git fetch upstream`; workflow states are only compared in CI.
  - **Strict type checks:** `yarn build --filter=api --filter=smtp` fails on type errors (upstream's `Type check` step
    never fails), and the fork's test code is type-checked with Vitest's module resolution, `@plunk/*` aliases and
    globals (`node scripts/fork/typecheck-changed-tests.mjs`): every line of the test files the fork adds, and the
    lines it adds to upstream test files. Upstream's own test code is not type-clean and is not checked, so an error
    that fork code causes on an unchanged upstream line is not reported either. A canary file with a known error
    proves that `tsc` type-checked at all.
  - **API reference:** `apps/wiki/openapi.json` must parse, and `yarn workspace wiki generate-docs` must succeed.
- **Remove when:** never (fork-only).

### D03 — Fork image releases

- **Since:** 2026-09-24
- **Kind:** ci
- **Upstream:** fork-only
- **Files:**
  - `.github/workflows/fork-release.yml`
  - `scripts/fork/registry.mjs`
- **What:** the `Fork release` workflow publishes this fork's image to `ghcr.io/fmd-labs/plunk` with upstream's native
  amd64 + arm64 build, in place of upstream's `docker-publish.yml`. `scripts/fork/registry.mjs` looks up image digests
  and tells a missing tag apart from a failed request. See **Releases** for the procedure.
- **Why:** a release is built once, smoke-tested, verified by hand, and promoted unchanged. Only the image the release
  tag names by digest can be promoted, and only if a successful candidate run of that commit and version published it.
  Candidate tags are written once, the workflow never replaces an existing release image, and no `latest` or floating
  tags are published.
- **Remove when:** never (fork-only).

## Repository settings

Settings that live in GitHub rather than in files:

- `next` is protected for everyone, administrators included: changes land through pull requests, and force pushes and
  deletion are blocked.
- Pull requests to `next` merge only when the `Divergence audit`, `Strict type checks & API reference`,
  `Lint & Type Check` and `Test Suite` checks pass.
- Tags matching `v*-fork.*` cannot be moved or deleted.
- Merge methods: squash for fork changes, merge commits for upstream syncs; rebase merging is off.
- Upstream's `docker-publish.yml`, `release.yml` and `npm-publish.yml` workflows must stay disabled in this fork's
  Actions settings. They would publish `sha-*` images to this fork's container registry on every push to `next`, open
  upstream-style release pull requests and create `vX.Y.Z` tags here, and try to publish upstream's npm package.
  Disable them right after enabling Actions, and review every workflow an upstream sync adds.

### Workflow inventory

Every file in `.github/workflows/` must be listed here with its state in this fork's Actions settings (the divergence
audit enforces both), so a workflow added by an upstream sync cannot start running in this fork unnoticed.

| Workflow             | Origin     | State in this fork |
| -------------------- | ---------- | ------------------ |
| `ci.yml`             | upstream   | enabled            |
| `docker-publish.yml` | upstream   | disabled           |
| `release.yml`        | upstream   | disabled           |
| `npm-publish.yml`    | upstream   | disabled           |
| `fork-checks.yml`    | fork (D02) | enabled            |
| `fork-release.yml`   | fork (D03) | enabled            |

## Releases

| Fork tag | Upstream base | Image | Divergences | Notes          |
| -------- | ------------- | ----- | ----------- | -------------- |
| —        | —             | —     | —           | no release yet |

Fork releases are tagged `v<upstream version>-fork.<n>`, for example `v0.15.0-fork.1`. `<upstream version>` is the
latest upstream release contained in the merge base (`git describe --tags --abbrev=0 <merge base>`), and `<n>` counts
fork releases on that upstream version. A fork tag is a SemVer pre-release, so it sorts below the upstream release of
the same number; that is intended, as no floating tags (`latest`, `0.15`) are published. The image tag drops the `v`:
`ghcr.io/fmd-labs/plunk:0.15.0-fork.1`.

To release:

1. Run the `Fork release` workflow on `next` with the version:
   `gh workflow run fork-release.yml --ref next -f version=0.15.0-fork.1`. The run is named `Candidate 0.15.0-fork.1`.
   It builds the amd64 and arm64 images once, publishes them only under a candidate tag unique to the run,
   `sha-<first 7 characters of the commit>-run.<run id>` (with the version in the image labels), and smoke-tests
   exactly that image on both architectures: migrations on a fresh database, then `/health`. The run summary lists the
   candidate by tag and digest, and the full commit. A candidate tag is written once: re-running a run keeps the
   candidate it published and smoke-tests that image again, and building again takes a new run.
2. The first candidate run creates the `plunk` package in this organization's container registry as private: make it
   public in the package settings (**Change visibility**) before promoting.
3. Verify the candidate image, by digest, end to end.
4. Once the candidate run has succeeded, tag its commit, naming the commit explicitly and the verified digest in the
   message, and push only that tag:
   `git tag -a v0.15.0-fork.1 <commit> -m "0.15.0-fork.1" -m "Image: ghcr.io/fmd-labs/plunk@sha256:<digest>"`, then
   `git push origin v0.15.0-fork.1` (never `git push --tags`). A pushed tag cannot be moved, so check it first:
   `git tag -l --format='%(contents)' v0.15.0-fork.1` and
   `docker buildx imagetools inspect ghcr.io/fmd-labs/plunk@sha256:<digest>` (a local tag can still be deleted with
   `git tag -d`). The tag run promotes exactly that digest, provided a
   successful `Candidate 0.15.0-fork.1` run of that commit on `next` published it, without rebuilding it. It checks that
   the image can be pulled anonymously before creating anything, never replaces an existing release image, and treats a
   release tag that already points to the digest as done, so a failed run can be re-run.
5. Record the release in the table above (tag, upstream base, image digest, divergences) in a follow-up pull request.

## Procedures

### Set up a clone

```sh
git clone https://github.com/fmd-labs/plunk.git && cd plunk
git remote add --no-tags upstream https://github.com/useplunk/plunk.git
git remote set-url --push upstream DISABLED
git fetch upstream
```

The fork already contains upstream's tags up to its creation; `--no-tags` keeps later upstream tags out of fork clones.
Fetch a specific upstream release tag explicitly when needed: `git fetch upstream tag v0.16.0`.

### Sync with upstream

1. `git fetch upstream`, then create `sync/upstream-<version-or-sha>` from `origin/next` and run `git merge upstream/next`
   (or an upstream release tag). Do not use GitHub's "Sync fork" button.
2. Resolve conflicts by keeping upstream's change and re-applying the divergence on top of it. Drop a divergence only
   on purpose, and remove its section in the same pull request.
3. Review every change under `.github/workflows/`: workflows added upstream run in this fork automatically. A new
   workflow that must stay disabled cannot be disabled before Actions has registered it, and it would run on the merge
   push. In the sync pull request, replace its triggers with `workflow_dispatch` (a divergence) and record it as
   `enabled`; once merged, disable it in the Actions settings, then restore its triggers and record it as `disabled` in
   a follow-up pull request.
4. Update **Base**, the upstream status of each divergence, and remove divergences that upstream has shipped. Open a
   pull request and merge it with a merge commit; squashing a sync loses the merge base.

### Roll back to an upstream image

Roll back only to the upstream image built from this fork's merge base, `ghcr.io/useplunk/plunk:sha-<first 7 characters
of the merge base>` (upstream publishes one per push to `next`), or to a newer upstream image. An older upstream image
can lack migrations the database has already applied. Divergence-specific caveats are listed under **Rollback notes**.

## Rollback notes

None yet.
