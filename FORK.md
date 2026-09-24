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
- **Files:** one backticked path per nested bullet: an exact path, or a directory prefix ending in `/`. Deleted files
  and the old path of a renamed file are listed too. A path may appear under more than one divergence.
- **What**, **Why** (optional) and **Remove when**.

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

## Repository settings

Settings that live in GitHub rather than in files:

- `next` is protected for everyone, administrators included: changes land through pull requests, and force pushes and
  deletion are blocked.
- Tags matching `v*-fork.*` cannot be moved or deleted.
- Merge methods: squash for fork changes, merge commits for upstream syncs; rebase merging is off.
- Upstream's `docker-publish.yml`, `release.yml` and `npm-publish.yml` workflows must stay disabled in this fork's
  Actions settings. They would publish `sha-*` images to this fork's container registry on every push to `next`, open
  upstream-style release pull requests and create `vX.Y.Z` tags here, and try to publish upstream's npm package.
  Disable them right after enabling Actions, and review every workflow an upstream sync adds.

## Releases

| Fork tag | Upstream base | Image | Divergences | Notes          |
| -------- | ------------- | ----- | ----------- | -------------- |
| —        | —             | —     | —           | no release yet |

Fork releases are tagged `v<upstream version>-fork.<n>`, for example `v0.15.0-fork.1`. `<upstream version>` is the
latest upstream release contained in the merge base (`git describe --tags --abbrev=0 <merge base>`), and `<n>` counts
fork releases on that upstream version. A fork tag is a SemVer pre-release, so it sorts below the upstream release of
the same number; that is intended, as no floating tags (`latest`, `0.15`) are published. Record each release in the
table, with the image by digest.

## Procedures

### Set up a clone

```sh
git clone https://github.com/fmd-labs/plunk.git && cd plunk
git remote add --no-tags upstream https://github.com/useplunk/plunk.git
git remote set-url --push upstream DISABLED
```

The fork already contains upstream's tags up to its creation; `--no-tags` keeps later upstream tags out of fork clones.
Fetch a specific upstream release tag explicitly when needed: `git fetch upstream tag v0.16.0`.

### Sync with upstream

1. `git fetch upstream`, then create `sync/upstream-<version-or-sha>` from `origin/next` and run `git merge upstream/next`
   (or an upstream release tag). Do not use GitHub's "Sync fork" button.
2. Resolve conflicts by keeping upstream's change and re-applying the divergence on top of it. Drop a divergence only
   on purpose, and remove its section in the same pull request.
3. Review every change under `.github/workflows/`: workflows added upstream run in this fork automatically.
4. Update **Base**, the upstream status of each divergence, and remove divergences that upstream has shipped. Open a
   pull request and merge it with a merge commit; squashing a sync loses the merge base.

### Roll back to an upstream image

Roll back only to the upstream image built from this fork's merge base, `ghcr.io/useplunk/plunk:sha-<first 7 characters
of the merge base>` (upstream publishes one per push to `next`), or to a newer upstream image. An older upstream image
can lack migrations the database has already applied. Divergence-specific caveats are listed under **Rollback notes**.

## Rollback notes

None yet.
