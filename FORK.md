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
- **Kind:** `feature`, `fix`, `refactor`, `docs` or `ci`.
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

### D04 — Email sends retry until attempts are exhausted

- **Since:** 2026-09-24
- **Kind:** fix
- **Upstream:** [useplunk/plunk#464](https://github.com/useplunk/plunk/pull/464) (open), by Vlad Bisceanu
- **Files:**
  - `apps/api/src/jobs/email-processor.ts`
  - `apps/api/src/jobs/__tests__/email-processor.test.ts`
  - `apps/api/src/jobs/__tests__/email-processor.retries.test.ts`
  - `packages/types/src/jobs/email.ts`
- **What:** upstream marks an email `FAILED` on its first failure of any kind, so the queue's retries find a
  non-`PENDING` row and never send it. With this change:
  - A failure before the SES call, or an SES answer of HTTP 429, 5xx or throttling, keeps the email `PENDING` for the
    next attempt until the job's attempts are exhausted.
  - Every other failure of the SES call marks the email `FAILED` without a queue retry: a rejection, and an error
    without a response (including one raised while the message is built), whose outcome is unknown. The AWS SDK's own
    retries are unchanged.
  - SES acceptance is checkpointed on the job (`acceptedBySes`) between the `SENDING` and `SENT` writes, so a retry
    after a database failure records the accepted message as `SENT` instead of sending it again.
  - A job that finds its email `SENDING` without a checkpoint marks it `FAILED` rather than risk a second send (upstream
    leaves it `SENDING`).
  - A failure after SES accepted the message leaves the email `SENT`, with a `Post-send processing failed` error.
- **Adapted to `next`:** the cancelled-campaign guard is skipped for a checkpointed acceptance (the message already
  left), and both `SENT` writes stamp `simulated`. `email-processor.retries.test.ts` covers both.
- **Known issue (resolved by D07):** campaign cancellation on `next` counts a `SENDING` email as sent. The `FAILED` mark
  for a `SENDING` email without a checkpoint carries no `sentAt`, so when no other email of the campaign has left, a
  cancel reads the campaign as never sent and reverts it to `DRAFT`, although SES may have accepted that email; sending
  the draft again would reach that recipient twice.
- **Changed by D07:** which failures are retried, the SDK's own retries, and what happens after a failure that follows
  the `SENT` write.
- **Remove when:** upstream merges #464 or an equivalent fix that also covers the cancelled-campaign guard and the
  `simulated` stamp; otherwise those two remain as a smaller divergence.

### D05 — Testable email job processor

- **Since:** 2026-09-24
- **Kind:** refactor
- **Upstream:** not proposed (upstream PR [#433](https://github.com/useplunk/plunk/pull/433), open, exports the same
  function as part of a larger change)
- **Files:**
  - `apps/api/src/jobs/email-processor.ts`
  - `apps/api/src/jobs/__tests__/process-email-job.test.ts`
- **What:** the email worker's job body moves, unchanged, out of the inline BullMQ callback into the exported
  `processEmailJob(job)`, which the worker passes as its processor. Tests call it directly with a stand-in job instead
  of starting a worker; `process-email-job.test.ts` covers the basic outcomes (sent, missing row, not pending, project
  disabled).
- **Sync:** the body is re-indented by 4 spaces. `git merge -Xignore-space-change` keeps upstream edits to it from
  conflicting on indentation alone; lines taken from upstream that way keep upstream's deeper indentation.
- **Why:** the job body could only be exercised through a running worker, and later fixes to the send path need
  direct tests.
- **Remove when:** upstream exports the job body. `process-email-job.test.ts` then goes upstream too, or stays listed
  here as the remaining divergence.

### D06 — SES message building separated from sending

- **Since:** 2026-09-24
- **Kind:** refactor
- **Upstream:** not proposed
- **Files:**
  - `apps/api/src/services/SESService.ts`
  - `apps/api/src/services/__tests__/SESService.rawEmail.test.ts`
- **What:** `sendRawEmail` is split in two: `buildRawEmail(params)` builds the MIME message and the values SES takes
  with it (`Source`, `Destinations`, configuration set) without contacting SES, and `submitRawEmail(email)` sends the
  result. `sendRawEmail` calls both and behaves as before. `SESService.rawEmail.test.ts` pins the exact message bytes
  for each MIME layout (alternative only, related, mixed, mixed with related); the expected messages were recorded from
  upstream's implementation before the split.
- **Why:** a caller can finish building a message, and everything that can fail while doing so, before it commits to
  sending; later changes to message building need byte-level regression tests.
- **Remove when:** upstream separates building a message from sending it. `SESService.rawEmail.test.ts` then goes
  upstream too, or stays listed here as the remaining divergence.

### D07 — SES outcomes decide retries, and failed emails finish their campaigns

- **Since:** 2026-09-24
- **Kind:** fix
- **Upstream:** not proposed
- **Files:**
  - `apps/api/src/jobs/email-processor.ts`
  - `apps/api/src/jobs/campaign-cancel-cleanup-processor.ts`
  - `apps/api/src/services/SESService.ts`
  - `apps/api/src/services/CampaignService.ts`
  - `apps/api/src/utils/sesSendFailure.ts`
  - `apps/api/src/utils/__tests__/sesSendFailure.test.ts`
  - `apps/api/src/services/__tests__/SESService.sendClient.test.ts`
  - `apps/api/src/services/__tests__/CampaignService.cancel.test.ts`
  - `apps/api/src/jobs/__tests__/process-email-job.test.ts`
  - `apps/api/src/jobs/__tests__/email-processor.test.ts`
  - `apps/api/src/jobs/__tests__/email-processor.retries.test.ts`
- **What:** builds on D04 and D06.
  - Queued emails are submitted through a separate SES client that makes one attempt per call, with a 5 s connection
    timeout and a 30 s request timeout. The SDK's default retries resubmit a message after a timeout or a dropped
    connection, when SES may already have accepted it. Campaign test sends and all other SES calls keep those retries.
  - A failed submission is classified by `classifySendFailure` (`utils/sesSendFailure.ts`). An SES answer of HTTP 429,
    5xx, throttling or a clock-skew error, and a failure to connect (DNS, refused, unreachable, the connection timeout),
    are retried. Any other error answer from SES is a rejection. Anything else, such as a dropped connection or a
    success answer that cannot be read, leaves the outcome unknown. Rejections and unknown outcomes are not retried.
  - Everything that can fail before SES is contacted (formatting, compiling and building the message, the phishing
    check) runs before the email is claimed, so such a failure leaves it `PENDING` for the next attempt. The claim
    (`PENDING` → `SENDING`) is conditional: of two runs of one email only one sends it, and a campaign email is claimed
    only while its campaign is still `SENDING`, so a cancel that lands while the email is prepared stops it.
  - Every write that fails an email, the cancelled-campaign guard's included, is conditional on the status the run
    found or claimed. A run never releases another run's claim, fails one only as an unknown outcome when it finds the
    email already `SENDING`, and never overwrites a finished email.
    Terminal failures let the email's campaign finish. An unknown outcome is recorded with an error starting with
    `SES outcome unknown`.
  - Campaign cancellation counts an email with an unknown outcome as possibly sent, and its cleanup no longer deletes
    `SENDING` emails or emails with an unknown outcome. An email claimed just as a cancel lands therefore keeps the
    campaign `CANCELLED`, instead of letting it revert to a draft whose next send would repeat that email.
  - A phishing block records the email's failure before it disables the project (disabling fails every `PENDING`
    email of the project with a generic error). Even when that write fails, the project is disabled and the job ends
    without a retry, since the check is sampled and would most likely not flag the email again.
  - The steps after the `SENT` write (campaign counters, usage, the `email.sent` event, campaign completion) are
    independent and best-effort: a failure is logged, the email stays `SENT` without an error, and the job completes.
  - The `email.sent` event carries the time SES accepted the message, also when a retry records an earlier
    acceptance. Every log line about an accepted message that could not be recorded names its SES message ID.
- **Known issue:** a run that loses its claim to another run of the same email completes its job. That takes BullMQ
  re-running a stalled job while its first run is still alive; if that first run then fails to record its outcome,
  the email is left `PENDING` or `SENDING` without a job.
- **Why:** with the SDK's retries, D04's rule that an unknown outcome is never retried did not hold. And a failure to
  connect, which cannot have sent anything, was retried only by the SDK's attempts in quick succession, never across
  the job's attempts.
- **Remove when:** upstream submits in single attempts and classifies failures the same way.

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

- **D04:** an upstream image ignores the `acceptedBySes` checkpoint on queued retry jobs, so an email whose SES
  acceptance was checkpointed but not yet recorded stays `SENDING`, and its campaign never finishes. Such jobs complete
  within their retry backoff once the database is reachable; before rolling back, check that no email is left
  `SENDING`. To repair one afterwards, copy `messageId` and `sentAt` from its job's `acceptedBySes` onto the row and
  mark it `SENT`. Emails the upstream image sends after an earlier failed attempt keep that attempt's `error` text,
  because upstream's `SENT` write does not clear it.
- **D07:** an upstream image's campaign cancellation does not count emails whose error starts with
  `SES outcome unknown` as possibly sent (D04's known issue returns for them).
