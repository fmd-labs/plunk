# Fork divergences

This repository is a fork of [useplunk/plunk](https://github.com/useplunk/plunk) (AGPL-3.0). This file lists every
**divergence**: each change that makes this fork differ from upstream `next`. A pull request that adds, changes or
removes a divergence updates this file in the same pull request.

## Base

- **Upstream:** [useplunk/plunk](https://github.com/useplunk/plunk), branch `next`
- **Merge base:** `76b4efbd9f1c2db4b0260407f6c97c19b2182518` (`v0.16.0` plus upstream `next` up to "fix: Add lazy loading
  of email bodies to speed up activity feed", 2026-10-13)
- **Fork created:** 2026-09-23. Last upstream sync: 2026-10-15.

## Policy

- **Schema changes stay additive and separable.** The fork may change `packages/db/prisma/schema.prisma` and add
  migrations of its own, so that an upstream image keeps working on a database the fork migrated (see **Roll back to
  an upstream image**) and an upstream migration never collides with the fork's. The divergence audit (D02) enforces
  what it can.
  - **Migrations.** Upstream's migrations and `migration_lock.toml` are never changed. Every fork migration has its own
    directory named `<timestamp>_fork_<name>` (lowercase; `yarn workspace @plunk/db migrate:dev --name fork_<name>`
    makes one), and is never edited or deleted once merged: a mistake is fixed by a later fork migration.
  - **Names.** Every table, enum, index and constraint the fork creates, and every column it adds to an upstream
    table, has a database name starting with `fork_` (`@@map`, `@map`, `map:`; constraint and index names of a `fork_`
    table start with it already), so a later upstream migration can never create the same name. The columns of a
    `fork_` table need no prefix of their own.
  - **What upstream owns is only added to:** tables; columns that are nullable or have a database default (a literal,
    `now()` or a stable `dbgenerated()`, not `uuid()`, `cuid()` or `@updatedAt`, which only Prisma's client fills
    in); indexes on fork columns. Fork migrations never rename, retype or drop upstream objects, add values to
    upstream enums, add constraints to upstream columns or write upstream-owned rows. A relation from a fork model to
    an upstream model sets `onDelete: Cascade` or `SetNull`, never Prisma's default `Restrict`, so upstream's deletes
    keep working. The fork may change and drop its own objects.
  - **Indexes on upstream's large tables** go into upstream's background index builder
    (`apps/api/src/jobs/background-index-builder.ts`, built concurrently at worker start), with `fork_` names; the
    fork adds entries there and never changes upstream's.
  - **Layout.** Fields the fork adds to an upstream model, back-relation fields Prisma requires included, form their
    own group after the model's last field, under a `// Fork (Dnn)` comment; fork `@@` lines follow upstream's,
    before `@@map`. Models and enums the fork adds sit at the end of `schema.prisma`. Upstream's lines stay
    byte-identical: never run `prisma format` over the whole file, since upstream's schema is not format-clean.
- **Generic and reusable.** The fork is a general-purpose Plunk: every divergence is useful to any operator, one that
  changes behavior is configurable and defaults to upstream's, and none names a particular deployment, product or
  customer, in code, comments, docs, commit messages and pull requests alike. Fork columns may appear in API
  responses that return whole rows; that only adds fields.
- **Upstream behavior by default.** New options and settings default to what upstream does today.
- **Upstream first where it fits.** Divergences that are useful to every Plunk deployment are proposed upstream; each
  records its upstream status, and a divergence is removed once upstream ships it.

## Format

Each divergence is a `### Dnn — title` section below. IDs are never reused. Each section has these bullets:

- **Since:** date the divergence was first merged into the fork.
- **Kind:** `feature`, `fix`, `refactor`, `test`, `docs` or `ci`.
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
  every divergence is recorded here and that schema changes follow the **Policy** above.
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
    name a directory the fork adds, upstream's migrations and `migration_lock.toml` stay unchanged, every migration
    the fork adds is named `<timestamp>_fork_<name>` and neither adds an enum value nor a `Restrict` or `No Action`
    foreign key (see **Policy**), a line of a **Files** list must be one backticked path, and every workflow file
    must be in the workflow inventory with the state it has in this repository's Actions settings. Run it locally with
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
  - `docker-compose.yml`
- **What:** the `Fork release` workflow publishes this fork's image to `ghcr.io/fmd-labs/plunk` with upstream's native
  amd64 + arm64 build, in place of upstream's `docker-publish.yml`. A candidate is built only from a commit on which
  the checks that branch protection requires have passed, and its smoke test requires the worker to start exactly once
  and the API to still answer 30 seconds later (PM2 restarts a crashing worker, which leaves `/health` green).
  `scripts/fork/registry.mjs` looks up image digests and tells a missing tag apart from a failed request. The bundled
  `docker-compose.yml` runs this fork's image, pinned to the release, since upstream's image ignores the fork's
  settings it passes. See **Releases** for the procedure.
- **Why:** a release is built once, smoke-tested, verified by hand, and promoted unchanged. Only the image the release
  tag names by digest can be promoted, and only if a successful candidate run of that commit and version published it:
  the run records the digest it published, and the promotion requires both that record and the candidate tag to name
  the verified digest. Candidate tags are written once, the workflow never replaces an existing release image, and no
  `latest` or floating tags are published.
- **Remove when:** never (fork-only).

### D04 — Email sends retry until attempts are exhausted

- **Since:** 2026-09-24
- **Kind:** fix
- **Upstream:** [useplunk/plunk#464](https://github.com/useplunk/plunk/pull/464) (closed unmerged by its author on
  2026-10-07), by Vlad Bisceanu
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
  - A failure after SES accepted the message leaves the email `SENT` (without an error since D07).
- **Adapted to `next`:** the cancelled-campaign guard is skipped for a checkpointed acceptance (the message already
  left), and both `SENT` writes stamp `simulated`. `email-processor.retries.test.ts` covers both.
- **Known issue (resolved by D07):** campaign cancellation on `next` counts a `SENDING` email as sent. The `FAILED` mark
  for a `SENDING` email without a checkpoint carries no `sentAt`, so when no other email of the campaign has left, a
  cancel reads the campaign as never sent and reverts it to `DRAFT`, although SES may have accepted that email; sending
  the draft again would reach that recipient twice.
- **Changed by D07:** which failures are retried, the SDK's own retries, and what happens after a failure that follows
  the `SENT` write.
- **Changed by D22:** a run that cannot record an accepted message waits for the database without spending the job's
  attempts.
- **Changed by D24:** a job that finds its email `SENDING` without a checkpoint, claimed less than 2 minutes ago, waits
  until then before it fails it; the checkpoint write gives up after 5 seconds.
- **Remove when:** upstream ships an equivalent of #464 that also covers the cancelled-campaign guard and the
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
  result. `sendRawEmail` calls both; the split itself changed nothing it does (D07 then gave queued sends a client of
  their own, which `sendRawEmail` does not use, and D08 changed how messages are built). `SESService.rawEmail.test.ts` pins the exact message bytes
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
    5xx, throttling or a clock-skew error (by its code, a `SignatureDoesNotMatch` saying the signature expired or is
    not yet current, or any refusal after which the SDK corrected its clock), and a failure to connect (DNS, refused,
    unreachable, the SDK's or Node's connection timeout, a failed certificate check, or every address of the host
    failing one of these ways), are retried. Any other error answer from SES is a rejection. Anything else,
    such as a dropped connection or a success answer that cannot be read, leaves the outcome unknown. Rejections and
    unknown outcomes are not retried.
  - Everything that can fail before SES is contacted (formatting, compiling and building the message, the phishing
    check) runs before the email is claimed, so such a failure leaves it `PENDING` for the next attempt. A failure of
    Plunk's own database or Redis is recorded as `Plunk could not prepare the email (internal error)`, not with its
    text, which can name internal hosts and queries and reaches the project (dashboard, D14, D24); the log keeps it. The claim
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
    without a retry, since the check is sampled and would most likely not flag the email again. The sampled check runs
    on a job's first run only, as upstream checks each email once: each run that found an email again counted as
    another detection towards the cumulative threshold.
  - The steps after the `SENT` write (campaign counters, usage, the `email.sent` event, campaign completion) are
    independent and best-effort: a failure is logged, the email stays `SENT` without an error, and the job completes.
  - The `email.sent` event carries the time SES accepted the message, also when a retry records an earlier
    acceptance. Every log line about an accepted message that could not be recorded names its SES message ID.
- **Known issue (resolved by D22):** a run that loses its claim to another run of the same email completes its job.
  That takes BullMQ re-running a stalled job while its first run is still alive; if that first run then fails to record
  its outcome, the email is left `PENDING` or `SENDING` without a job.
- **Known issue:** when SES rejects a message and the write of that failure fails too, a later run records the email
  as an unknown outcome, since only the run that submitted it knew the answer: the email reads as possibly sent.
- **Changed by D24:** terminal failures are reported as `email.failed`, and a phishing block reports its failure once
  the project is disabled.
- **Why:** with the SDK's retries, D04's rule that an unknown outcome is never retried did not hold. And a failure to
  connect, which cannot have sent anything, was retried only by the SDK's attempts in quick succession, never across
  the job's attempts.
- **Remove when:** upstream submits in single attempts and classifies failures the same way.

### D08 — Encoded and injection-safe message headers

- **Since:** 2026-09-24
- **Kind:** fix
- **Upstream:** not proposed
- **Files:**
  - `apps/api/src/utils/mime.ts`
  - `apps/api/src/services/SESService.ts`
  - `packages/shared/src/schemas/index.ts`
  - `apps/api/src/utils/__tests__/mime.headers.test.ts`
  - `apps/api/src/services/__tests__/SESService.headers.test.ts`
  - `apps/api/src/services/__tests__/SESService.rawEmail.test.ts`
  - `packages/shared/src/__tests__/send-schema.headers.test.ts`
- **What:** upstream writes the subject, display names and header values into the message as they are. With this
  change:
  - A subject, display name or `X-` header value that is not ASCII is written as RFC 2047 encoded words (UTF-8,
    base64), folded so that no line passes 76 characters; an address list folds between addresses, keeping room for
    the comma that ends a line. RFC 5322 headers are ASCII, and clients show raw UTF-8 as mojibake. Other custom headers (addresses, URLs, message IDs) have a structure that encoded words would break, and
    are written as they are.
  - A display name with special characters is quoted, so a comma no longer splits the address list (`Lovelace, Ada`
    read as two addresses).
  - An attachment name that is not ASCII is an RFC 2231 `filename*` in UTF-8, in numbered continuations of whole
    characters when it would make a line longer than 78 characters, and without an ASCII `filename`, which parsers
    that find both read instead. Content-Type adds the name in encoded words for clients that do not read RFC 2231.
  - Line breaks and other control characters in a header value become spaces, so a subject rendered from contact data
    or a name cannot add headers. A custom header whose name is not an RFC 5322 field name is left out. The send schema
    also rejects line breaks in recipient names, the sender `name` and attachment content types.
  - SES's `Source` is the bare sender address, where upstream passes the unencoded `Name <address>`.
  - Headers of plain ASCII words are unchanged byte for byte (`SESService.rawEmail.test.ts`). ASCII headers change
    only where upstream's were ambiguous or malformed: a display name with special characters (`Acme Inc.`) is quoted,
    names and addresses are trimmed and an empty name leaves the bare address, control characters become spaces in
    values (the subject, names, addresses, custom header values, attachment content types and names), a custom header
    whose name is not a field name is left out, a `\` or `"` in a file name is escaped, and angle brackets leave a
    Content-ID taken from a file name.
- **Remove when:** upstream encodes and sanitizes headers.

### D09 — Project cancellation reaches prioritized jobs

- **Since:** 2026-09-24
- **Kind:** fix
- **Upstream:** not proposed
- **Files:**
  - `apps/api/src/services/QueueService.ts`
  - `apps/api/src/services/__tests__/QueueService.cancelAllProjectJobs.test.ts`
- **What:** every email job is queued with a priority, so it waits in BullMQ's `prioritized` state, which
  `cancelAllProjectJobs` never read: disabling a project removed none of its queued emails, and the worker then spent
  its rate limit failing them one by one. Cancellation now reads the `delayed`, `prioritized` and `waiting` states of
  every queue it clears, in the order jobs move between them, and removes the project's jobs a page at a time, with
  one ownership lookup per page instead of one per job, so it holds one page of jobs rather than every job of a large
  campaign. Pages are read from the newest job down, so jobs a worker takes meanwhile do not make it skip any. It keeps
  the jobs that settle an email that may already be out: one that checkpointed an SES acceptance (D04), which records it
  as sent, and the retry of an email left `SENDING`. A job that cannot be removed, or that is gone by the time it is
  read, no longer stops the cancellation. Each queue is cleared on its own: one that fails leaves the others to be
  cleared, the project's pending emails are failed all the same, and the first failure is raised after that.
  `getStats` counts prioritized jobs.
- **Known issue:** a send attempt that fails with its email left `SENDING` after the email's ownership was looked up,
  and queues its retry before the job is removed, loses that retry: the email stays `SENDING` until D25's sweep fails
  it as an unknown outcome.
- **Remove when:** upstream cancels prioritized jobs.

### D10 — Configurable email send retries

- **Since:** 2026-09-24
- **Kind:** feature
- **Upstream:** not proposed
- **Files:**
  - `apps/api/src/app/constants.ts`
  - `apps/api/src/services/QueueService.ts`
  - `apps/api/src/app/__tests__/emailSendRetries.test.ts`
  - `apps/api/.env.example`
  - `.env.self-host.example`
  - `apps/wiki/content/docs/self-hosting/environment-variables.mdx`
  - `docker-compose.yml`
- **What:** `EMAIL_SEND_ATTEMPTS` (default `3`, from `1` to `10`) and `EMAIL_SEND_BACKOFF_MS` (default `2000`, at most
  `60000`) set the attempts of each email job and the delay before its first retry, which doubles for each retry after
  it; upstream hard-codes both. The defaults are upstream's values. At the maximums, an email's retries span about 8.5
  hours. Any other value stops the API and the worker at startup (`integerEnv` in `constants.ts`). Jobs keep the options
  they were queued with, so a change applies to emails queued after a restart. The API (transactional emails) and the
  worker (campaign and workflow emails) both queue emails, so where they run as separate processes both need the same
  values. The bundled `docker-compose.yml` passes both variables to the container.
- **Why:** how long retryable failures (D04, D07) are retried is a deployment choice.
- **Remove when:** upstream makes the email retry budget configurable.

### D11 — Configurable email body retention

- **Since:** 2026-09-24
- **Kind:** feature
- **Upstream:** not proposed
- **Files:**
  - `apps/api/src/app/constants.ts`
  - `apps/api/src/jobs/email-body-cleanup-processor.ts`
  - `apps/api/src/jobs/__tests__/email-body-cleanup.test.ts`
  - `apps/api/.env.example`
  - `.env.self-host.example`
  - `apps/wiki/content/docs/self-hosting/environment-variables.mdx`
  - `apps/wiki/content/docs/guides/data-retention.mdx`
  - `docker-compose.yml`
- **What:** `EMAIL_BODY_RETENTION_DAYS` (default `90`, upstream's fixed value) sets how many days a sent email keeps its
  rendered HTML body before the worker's daily cleanup clears it; `0` keeps every body, and the maximum is `36500`. Anything
  else stops the API and the worker at startup. The bundled `docker-compose.yml` passes the variable to the container.
  `processCleanup` is exported for tests.
- **Also:** the cleanup no longer clears the body of an email that is still `PENDING` or `SENDING`, which the worker
  would then send empty. With upstream's 90 days a send rarely lasts that long; a short retention makes it likely. An
  email that never leaves `PENDING` or `SENDING` keeps its body.
- **Remove when:** upstream makes the retention configurable.

### D12 — Complete IAM policy in the SES setup guide

- **Since:** 2026-09-24
- **Kind:** docs
- **Upstream:** not proposed
- **Files:**
  - `apps/wiki/content/docs/self-hosting/email-setup.mdx`
- **What:** the documented IAM policy adds `ses:GetSendQuota`, without which the email worker cannot read the account's
  sending rate and, unless `EMAIL_RATE_LIMIT_PER_SECOND` sets one, falls back to 14 emails per second, and
  `ses:DeleteIdentity`, which deleting a domain uses to remove its SES identity. The worker calls `GetSendQuota` when
  it starts, the API `DeleteIdentity`.
- **Remove when:** upstream's policy lists both actions.

### D13 — Link to the deployment's source code

- **Since:** 2026-09-24
- **Kind:** feature
- **Upstream:** not proposed
- **Files:**
  - `apps/api/src/app/constants.ts`
  - `apps/api/src/controllers/Config.ts`
  - `apps/api/src/app/__tests__/sourceCodeUrl.test.ts`
  - `apps/web/src/lib/hooks/useConfig.ts`
  - `apps/web/src/components/DashboardLayout.tsx`
  - `apps/web/src/components/list-management/ListManagement.tsx`
  - `packages/shared/src/i18n/locales/bg.json`
  - `packages/shared/src/i18n/locales/cs.json`
  - `packages/shared/src/i18n/locales/cy.json`
  - `packages/shared/src/i18n/locales/de.json`
  - `packages/shared/src/i18n/locales/en.json`
  - `packages/shared/src/i18n/locales/es.json`
  - `packages/shared/src/i18n/locales/fr.json`
  - `packages/shared/src/i18n/locales/hi.json`
  - `packages/shared/src/i18n/locales/it.json`
  - `packages/shared/src/i18n/locales/ja.json`
  - `packages/shared/src/i18n/locales/nl.json`
  - `packages/shared/src/i18n/locales/pl.json`
  - `packages/shared/src/i18n/locales/pt.json`
  - `packages/shared/src/i18n/locales/sv.json`
  - `packages/shared/src/i18n/locales/zh-CN.json`
  - `packages/shared/src/i18n/locales/zh-HK.json`
  - `packages/shared/src/i18n/locales/zh-TW.json`
  - `apps/api/.env.example`
  - `.env.self-host.example`
  - `apps/wiki/content/docs/self-hosting/environment-variables.mdx`
  - `docker-compose.yml`
- **What:** `SOURCE_CODE_URL` names where the source code of the deployment is published. When it is set, `GET /config`
  returns it (`features.sourceCode.url`), the dashboard navigation links to it, and the unsubscribe, subscribe and
  manage pages add a link after the provider attribution, labelled in each of their languages
  (`pages.common.sourceCode`). It must be an http(s) URL; anything else stops the API and the worker at startup. Unset shows no link,
  as upstream. The bundled `docker-compose.yml` passes the variable to the container.
- **Why:** a modified version run as a network service has to offer its source to the people using it (AGPL-3.0
  section 13).
- **Remove when:** upstream adds an equivalent setting.

### D14 — Email status endpoint

- **Since:** 2026-09-24
- **Kind:** feature
- **Upstream:** not proposed
- **Files:**
  - `apps/api/src/controllers/Emails.ts`
  - `apps/api/src/controllers/__tests__/Emails.test.ts`
  - `apps/api/src/app.ts`
  - `apps/api/src/middleware/requestLogger.ts`
  - `apps/api/src/middleware/__tests__/requestLogger.test.ts`
  - `apps/wiki/openapi.json`
  - `apps/wiki/content/docs/api-reference/meta.json`
  - `apps/wiki/content/docs/api-reference/overview.mdx`
- **What:** `GET /v1/emails/:id` (secret key) returns an email's status, error, SES message ID, source, the time of
  each delivery event and its open and click counts, but none of its content. Another project's email answers `404`,
  like one that does not exist. Since callers poll the endpoint, the request log records only its failed requests.
  Like upstream's other reads it has no rate limit: it is one lookup by primary key.
- **Why:** upstream documents no way to check one email's delivery over the API; the status arrives as webhooks.
- **Remove when:** upstream adds an equivalent endpoint.

### D21 — Concurrent writes of a new contact both succeed

- **Since:** 2026-09-24
- **Kind:** fix
- **Upstream:** not proposed (upstream PR [#469](https://github.com/useplunk/plunk/pull/469), closed unmerged by its
  author on 2026-10-07, fixed the same race differently: the request that loses it reads the other's contact without
  writing its own data)
- **Files:**
  - `apps/api/src/services/ContactService.ts`
  - `apps/api/src/services/__tests__/ContactService.upsert.test.ts`
- **What:** `ContactService.upsert` looks a contact up and creates it when there is none. Two requests writing the same
  new contact at once both found none, and the one whose create lost on the unique constraint answered `500` with the
  database's error message. It now updates the contact the other request created, as if it had found it. Sends, events,
  contact writes, imports and inbound email all write contacts this way.
- **Known issue:** `POST /contacts` and contact imports look the contact up themselves before writing it, so the
  request that loses the race still reports the contact as new (`201`, `_meta.isNew`; counted as created).
- **Remove when:** upstream handles the race.

### D15 — Tests for the transactional send endpoint

- **Since:** 2026-09-24
- **Kind:** test
- **Upstream:** not proposed
- **Files:**
  - `apps/api/src/controllers/__tests__/Actions.send.test.ts`
- **What:** tests that call the `POST /v1/send` handler directly and pin what it does today: one queued transactional
  email per recipient and the response listing their IDs, the sender name and reply-to precedence, templates and their
  overrides, placeholder rendering, stored headers and attachments, contact subscription handling, and each error. A
  domain, marketing-template or billing-limit refusal carries no error code, so the API reports it as
  `INTERNAL_SERVER_ERROR` with its 4xx status; and a failure on a later recipient leaves the emails of earlier
  recipients queued.
- **Why:** upstream has no tests of the handler itself (its send tests cover the schema and the services), and later
  changes to the endpoint need a baseline.
- **Remove when:** upstream has equivalent handler tests.

### D16 — Transactional sends in a service

- **Since:** 2026-09-24
- **Kind:** refactor
- **Upstream:** not proposed
- **Files:**
  - `apps/api/src/controllers/Actions.ts`
  - `apps/api/src/services/TransactionalSendService.ts`
- **What:** the logic of `POST /v1/send` moves, unchanged, from the controller into `TransactionalSendService`:
  `prepare` resolves a request against its project (recipients, sender, template content, the sender's domain), and
  every refusal it raises comes before anything is written; `sendTo` sends to one recipient (contact, placeholders,
  email and its job), refusing a marketing template or a send past the billing limit after the contact is written, as
  before; `sendToAll` sends to each recipient in order. The controller parses the request and calls them. D15's tests
  pass unchanged.
- **Sync:** an upstream change to the send logic in the controller's `send` conflicts with this move; apply it to
  `TransactionalSendService` instead.
- **Why:** sending to one recipient separately from resolving the request is what idempotent per-recipient sends and
  a batch endpoint build on.
- **Remove when:** upstream moves this logic out of the controller in a compatible shape.

### D17 — Transactional sends retried without duplicates

- **Since:** 2026-09-24
- **Kind:** feature
- **Upstream:** not proposed
- **Files:**
  - `apps/api/src/controllers/Actions.ts`
  - `apps/api/src/middleware/idempotency.ts`
  - `apps/api/src/middleware/__tests__/idempotency.test.ts`
  - `apps/api/src/utils/prismaErrors.ts`
  - `apps/api/src/services/TransactionalSendService.ts`
  - `apps/api/src/services/EmailService.ts`
  - `apps/api/src/utils/uuid.ts`
  - `apps/api/src/utils/__tests__/uuid.test.ts`
  - `apps/api/src/controllers/__tests__/Actions.send.idempotency.test.ts`
  - `apps/wiki/openapi.json`
  - `apps/wiki/content/docs/guides/idempotency.mdx`
- **What:** builds on D16. With an `Idempotency-Key`, `POST /v1/send` creates each recipient's email under an ID
  derived from the key's claim, the recipient's address and how often that address came earlier in the request (a
  version 5 UUID), so a retry finds the emails an earlier request created, however it orders the recipients.
  - A retry of a request that succeeded, or is still in flight (unanswered for less than 30 seconds), is refused with
    `409` as before, now with `details.emails`: the emails that request queued, in the shape of `data.emails`.
  - A retry of a request that failed, or never answered and started at least 30 seconds ago, finishes it: the emails
    already created are reported as they are (queued again if still waiting, which the queue ignores while it holds the
    job, finished or not), the missing ones are sent, and it answers `200` with all of them. The claim then records the
    success.
  - A `4xx` raised once the send has started writing (a recipient refused: a marketing template for an unsubscribed
    contact, or the billing limit) keeps the claim, so a retry after the fix sends only to the rest; a `4xx` raised
    before (validation, template, sender domain) releases it as upstream.
  - An email whose job cannot be queued fails the request. With a key it stays `PENDING`, and the retry with the key
    queues it (or the stalled-email sweep of D25 does, after 15 minutes, unless it is a day old by then); without one
    it is removed, since the caller's retry sends a new email, rather than left `PENDING` without a job.
  - A key whose claim expired is claimed anew, also before the hourly cleanup has removed the old claim, which a reuse
    otherwise resumed: it reported the old emails and sent nothing.
  - The release of a claim on a `4xx` is conditional on the claim being unsettled, so that a request answering late
    cannot release a claim a retry took over and settled.
  - Claims store the full path (`/v1/send`), which `details.originalRequest` shows, as the docs always said; upstream
    stores the router's path (`/send`). A claim stored that way is still taken over.
  - `POST /v1/track` keeps upstream's behavior (`idempotency`); only `/v1/send` uses `resumableIdempotency`.
- **Why:** upstream answers a retried send with `409` and no email IDs, and a send that failed partway can neither be
  finished nor safely retried.
- **Remove when:** upstream makes retried sends finish per recipient.

### D18 — Sends without templating, and Plunk's own headers reserved

- **Since:** 2026-09-24
- **Kind:** feature
- **Upstream:** not proposed
- **Files:**
  - `packages/shared/src/schemas/index.ts`
  - `packages/shared/src/__tests__/send-schema.templating.test.ts`
  - `apps/api/src/services/TransactionalSendService.ts`
  - `apps/api/src/services/EmailHeaderService.ts`
  - `apps/api/src/jobs/email-processor.ts`
  - `apps/smtp/src/server.ts`
  - `apps/api/src/controllers/__tests__/Actions.send.test.ts`
  - `apps/api/src/jobs/__tests__/process-email-job.test.ts`
  - `apps/wiki/openapi.json`
  - `apps/wiki/content/docs/guides/template-language.mdx`
- **What:**
  - `"templating": false` on `/v1/send` sends the subject and body exactly as given. The API skips its Liquid pass
    and marks the email with the internal header `X-Plunk-Templating: off`, on which the worker skips its own. Combined
    with `template` it is refused (`422`).
  - Every `X-Plunk-*` header stored on an email is Plunk's own: the worker strips them all before sending (upstream
    strips only `X-Plunk-Recipient-Override`), `/v1/send` refuses them from callers (`422`), and the SMTP relay drops
    them. `/v1/send` header names must also be RFC 5322 field names (printable ASCII except the colon).
- **Why:** content another system already rendered could be changed by Plunk's two templating passes (text that
  contains `{{` or `{%`), and a caller could set the internal recipient override and send the email elsewhere.
- **Changed by D28:** senders store every email they render with `X-Plunk-Templating: off`, so the header now also
  marks an email rendered once already.
- **Remove when:** upstream adds an equivalent option and reserves its internal headers.

### D19 — Priority per send

- **Since:** 2026-09-24
- **Kind:** feature
- **Upstream:** not proposed
- **Files:**
  - `packages/shared/src/schemas/index.ts`
  - `packages/shared/src/__tests__/send-schema.templating.test.ts`
  - `apps/api/src/services/QueueService.ts`
  - `apps/api/src/services/__tests__/QueueService.cancelAllProjectJobs.test.ts`
  - `apps/api/src/services/EmailService.ts`
  - `apps/api/src/services/EmailHeaderService.ts`
  - `apps/api/src/services/TransactionalSendService.ts`
  - `apps/api/src/controllers/__tests__/Actions.send.test.ts`
  - `apps/api/src/controllers/__tests__/Actions.send.idempotency.test.ts`
  - `apps/wiki/openapi.json`
  - `apps/wiki/content/docs/concepts/transactional-emails.mdx`
- **What:** `"priority": "high" | "normal" | "low"` on `/v1/send` sets the email's BullMQ priority to `1`, `5` or `10`,
  the places transactional, workflow and campaign emails take by default; without it the email is queued as upstream
  queues it (`1`). A priority the sender chose is stored in the internal `X-Plunk-Priority` header (D18), so an email
  queued again later, as a retried send does (D17), keeps its place.
- **Why:** every transactional email shares the top priority, so a large send of low-urgency mail through the API
  delays the urgent emails queued behind it.
- **Remove when:** upstream lets a send choose its priority.

### D20 — Batch sends

- **Since:** 2026-09-24
- **Kind:** feature
- **Upstream:** not proposed
- **Files:**
  - `packages/shared/src/schemas/index.ts`
  - `apps/api/src/controllers/Actions.ts`
  - `apps/api/src/controllers/__tests__/Actions.sendBatch.test.ts`
  - `apps/api/src/services/TransactionalSendService.ts`
  - `apps/api/src/services/EmailService.ts`
  - `apps/api/src/middleware/idempotency.ts`
  - `apps/api/src/middleware/rateLimit.ts`
  - `apps/wiki/openapi.json`
  - `apps/wiki/content/docs/api-reference/meta.json`
  - `apps/wiki/content/docs/api-reference/overview.mdx`
  - `apps/wiki/content/docs/guides/idempotency.mdx`
  - `apps/wiki/content/docs/concepts/transactional-emails.mdx`
  - `apps/wiki/content/docs/self-hosting/environment-variables.mdx`
  - `apps/api/.env.example`
  - `.env.self-host.example`
- **What:** builds on D16, D17 and D19. `POST /v1/send/batch` (secret key) sends up to 100 emails, each a
  `/v1/send` body with one recipient (`SendBatchSchema`).
  - Every email is validated and prepared (template, sender domain) before any is sent, reading each template and
    checking each sender once per batch; any refusal fails the request with `422` and a field error per email
    (`emails.<index>`), and nothing is sent.
  - The emails are sent ten at a time; the emails to one address go one after another in the order of the batch, as
    they write the same contact.
  - Each email then gets a result, in order: `queued`, `duplicate` or `failed` (`code`, `message`, `retryable`). A
    failure does not stop the rest. A failure on Plunk's side (`5xx`) is reported without its message. A refusal of
    the send path that carries no error code of its own (upstream answers those as `INTERNAL_SERVER_ERROR`) gets one
    by its status: `BILLING_LIMIT_EXCEEDED` for `429`, the billing limit, as the rate limit applies to the whole
    request; `FORBIDDEN`, `RESOURCE_NOT_FOUND` or `BAD_REQUEST` otherwise. The `422` field errors use the same codes.
  - An email's optional `idempotencyKey` is claimed like an `Idempotency-Key` header, under a name headers cannot take
    (`claimKey`, shared with the middleware), and the email is created under an ID derived from the claim alone: an
    email a batch with the same key already created is reported as `duplicate`, with its ID and contact, even when
    the recipient changed, and queued again if it still waits without a job; two batches racing with one key create it
    once. Keys expire with the header keys. The `Idempotency-Key` header itself is refused with `400`, as it would
    read as covering the batch.
  - An email with a key is `queued` once it is saved, also when its job could not be queued: the stalled-email sweep
    (D25) sends it (unless `EMAIL_STALL_SWEEP_ENABLED=false`), or a retry with its key queues it at once. Reported as failed, it invited a send under another key
    or provider, which would reach the recipient twice. Without a key such an email is removed and reported as
    failed.
  - The request counts once against a rate-limit budget of its own (`send-batch`, with the `/v1/send` numbers).
- **Known issue:** the billing limit is checked per email, ten at a time, so a batch can pass the limit by up to nine
  emails.
- **Why:** sending many emails through `/v1/send` takes a request per email, and a failed request mid-way cannot tell
  which emails went out.
- **Remove when:** upstream adds a batch endpoint with per-email results and keys.

### D22 — Accepted sends recorded without spending attempts, and a backstop for failed jobs

- **Since:** 2026-09-24
- **Kind:** fix
- **Upstream:** not proposed
- **Files:**
  - `apps/api/src/jobs/email-processor.ts`
  - `apps/api/src/jobs/__tests__/process-email-job.test.ts`
  - `apps/api/src/jobs/__tests__/email-processor.test.ts`
  - `apps/api/.env.example`
  - `.env.self-host.example`
  - `apps/wiki/content/docs/self-hosting/environment-variables.mdx`
- **What:** builds on D04, D07 and D10.
  - A run that cannot record a message SES accepted (the database fails the `SENT` write and its retry, or the email
    cannot be loaded) moves its job back to delayed with `moveToDelayed` instead of failing an attempt: the next run
    records the checkpointed acceptance. The wait starts at 1 s and grows with the time since the acceptance, up to
    2 minutes; no attempt is spent, so an email SES accepted is recorded however long the database is unavailable,
    even with `EMAIL_SEND_ATTEMPTS=1`. The job first moves ahead of the emails waiting to be sent (priority `0`, which
    BullMQ takes before any prioritized job): a delayed job that falls due otherwise queues behind every job of its
    priority, so a campaign email recorded its acceptance only after the rest of its campaign, hours later, past D23's
    hour. A wait for another run of the email (below, and D24's) keeps the job's priority, as the job may still send
    the email.
  - A run that loses its claim to another run of the same email (BullMQ ran the job again after it stalled, while its
    first run was alive) looks at the email again after 2 minutes instead of completing the job, which is then still
    there to record the outcome should that first run fail to (D07's known issue).
  - A job that failed for good settles its email where its run did not: `settleFailedJob` runs on the worker's
    `failed` event once the job has finished, and settles an email its run left `PENDING` or `SENDING` (a write that
    failed with the send, or a job BullMQ failed without running it after it stalled too often). A checkpointed
    acceptance is run again, which records it, before the email is read, as the database may be what failed the job; a
    `SENDING` email is failed as an unknown outcome, a `PENDING` one with the job's error. It is best-effort: it tries once, and a failure, such as the database still being unavailable, is
    only logged. It never rejects.
  - `processEmailJob` takes the worker's job token, which moving an active job requires.
- **Changed by D25:** `settleFailedJob` leaves a `SENDING` email claimed less than 2 minutes ago to the stalled-email
  sweep.
- **Why:** an email SES accepted must end `SENT`: with the attempts spent on recording it, a longer database outage
  left it `SENDING` for good, and a stalled job could leave an email unsettled with no job to settle it.
- **Remove when:** upstream records accepted sends without spending attempts and settles the emails of failed jobs.

### D23 — SNS delivers again an event that arrives before its email is recorded

- **Since:** 2026-09-24
- **Kind:** fix
- **Upstream:** not proposed
- **Files:**
  - `apps/api/src/controllers/Webhooks.ts`
  - `apps/api/src/controllers/__tests__/Webhooks.sns.test.ts`
  - `apps/wiki/content/docs/self-hosting/email-setup.mdx`
- **What:** builds on D22. SNS delivers an event again after a 5xx, never after a 404, and the SES event webhook
  answered every error with `200`.
  - An event whose message ID matches no email is answered with `503` instead of `404` for an hour after SES accepted
    the message (`mail.timestamp`): the worker records the message ID after the acceptance, and waits out a database
    failure to do so (D22), so an event can arrive first. It records it within about 2 minutes of being able to write
    again, so the hour covers the messages in flight when an outage of up to about an hour began. Only the event types
    the handler records (delivery, open, click, bounce, complaint) are waited for, and never those of a campaign test
    send (`X-Plunk-Test`), which is not recorded as an email, nor those of a message sent with a configuration set
    other than the deployment's two (`mail.tags`), which another deployment on a shared SNS topic sent. Older events,
    and events without a time, still get `404`.
  - A failure to look the email up is answered with `503` for the same events: nothing is written before it. Any
    other failure still answers `200`, as a redelivery could apply the event twice.
  - The SES setup guide says which answers SNS retries and shows a delivery policy that retries for longer than the
    default minute.
- **Why:** an event that arrived just before its email was recorded, for example after a database outage, was lost.
- **Remove when:** upstream retries events for messages it has not recorded yet.

### D24 — An event for emails that fail for good

- **Since:** 2026-09-24
- **Kind:** feature
- **Upstream:** not proposed
- **Files:**
  - `apps/api/src/jobs/email-processor.ts`
  - `apps/api/src/jobs/__tests__/process-email-job.test.ts`
  - `apps/api/src/jobs/__tests__/email-processor.test.ts`
  - `apps/wiki/content/docs/guides/webhooks.mdx`
- **What:** builds on D07 and D22.
  - The worker tracks `email.failed` for an email it gives up on, from `markTerminalFailure` and only when that write
    records the failure, so it fires once per email. The event carries the base fields of the other email events,
    with `messageId` `null`, plus `error`, `reason`, `attempts` (the job's runs) and `failedAt`. `reason` is
    `ses_rejected`, `ses_outcome_unknown`, `stalled_without_checkpoint` (an email found `SENDING` without an
    acceptance checkpoint), `attempts_exhausted`, `project_disabled` or `phishing_blocked`.
  - A run that finds an email `SENDING` without a checkpoint, claimed less than 2 minutes ago, waits until then
    (`moveToDelayed`, as D22 does) instead of failing it: the run that claimed it may still be alive and record it as
    sent, which would follow the failure with `email.sent`. That run gives up on checkpointing an acceptance after 5
    seconds and records the send without it, so that a hung Redis cannot hold it past those 2 minutes.
  - A run held up longer all the same (a stalled process, a database that does not answer) still records what SES
    accepted: its `SENT` write, and a later run's record of its checkpoint, replace a `FAILED` email whose error says the
    outcome is unknown, never a definite failure. The email then has its message ID, whose delivery, bounce and
    complaint events are recorded, and `email.sent` follows the `email.failed` of reason `stalled_without_checkpoint`
    (a `ses_outcome_unknown` failure is recorded by the run that submitted the message, which has no acceptance to
    record).
  - A phishing block records the email's failure, disables the project, and only then reports the failure, so that
    none of the project's workflows run before it is disabled; a workflow an event of a disabled project triggers is
    cancelled at once.
  - It is not tracked for emails of a stopped campaign, for those `cancelAllProjectJobs` fails in bulk, for workflow
    emails skipped for an unsubscribed contact, or for the emails D25's sweep fails without sending (too old, or of a
    disabled project). As an `email.*` name it is reserved like the others and can
    trigger workflows; the webhooks guide documents it, how workflow re-entry limits forwarding it, and why a workflow
    it triggers must not send email. Like upstream's other `email.*` events, it is not listed in the dashboard's
    activity feed, contact timeline or top-events analytics (upstream filters `email.*` there since 0.16).
- **Why:** upstream records a failed email only on its row, so a sender learns of it only by polling.
- **Remove when:** upstream tracks an equivalent event.

### D25 — A sweep for emails left without a job

- **Since:** 2026-09-24
- **Kind:** fix
- **Upstream:** not proposed
- **Files:**
  - `apps/api/src/jobs/email-processor.ts`
  - `apps/api/src/jobs/email-stall-sweep-processor.ts`
  - `apps/api/src/jobs/__tests__/email-stall-sweep.test.ts`
  - `apps/api/src/jobs/__tests__/process-email-job.test.ts`
  - `apps/api/src/jobs/__tests__/email-processor.test.ts`
  - `apps/api/src/jobs/worker.ts`
  - `apps/api/src/app.ts`
  - `apps/api/src/app/constants.ts`
  - `apps/api/src/app/__tests__/emailStallSweep.test.ts`
  - `apps/api/src/services/QueueService.ts`
  - `apps/api/src/services/keys.ts`
  - `packages/types/src/jobs/email.ts`
  - `apps/api/.env.example`
  - `.env.self-host.example`
  - `apps/wiki/content/docs/self-hosting/environment-variables.mdx`
  - `apps/wiki/content/docs/guides/idempotency.mdx`
  - `apps/wiki/content/docs/guides/webhooks.mdx`
  - `docker-compose.yml`
- **What:** builds on D19, D22 and D24.
  - Every five minutes, a repeatable job on its own queue (`email-stall-sweep`) settles the emails left `PENDING` or
    `SENDING` for 15 minutes or more (by `updatedAt`) without a job to send them or record their outcome: a job lost
    from Redis, a job that failed for good while the email could not be written, an email whose job could not be
    queued (`sweepStalledEmails`, in `email-stall-sweep-processor.ts`). It leaves an email whose job still waits or
    runs to that job.
  - A run makes two passes, each going on where the last run stopped (`Keys.Email.stallSweepCursor`; a place that
    cannot be read is logged and ignored): the emails of no campaign (transactional and workflow emails, through the
    `(campaignId, status)` index, with half the run's time at most), then campaign emails. A large campaign can keep
    millions of emails waiting their turn, behind which a lost transactional email was found hours late.
  - A pass reads ids and times only, 20,000 at a time from the one untouched the longest (keyset on `updatedAt` and
    `id`), asks Redis for their jobs' states 500 at a time, and reads the rest of an email only when its job is gone.
    No index serves that order (the fork adds none for this, and paging by `createdAt` would walk the whole
    `createdAt` index), so each page reads every `PENDING` and `SENDING` email of the pass: about 60 ms with 500,000
    of them, about a second with millions, when a pass of the campaign emails takes several runs.
  - A run stops after 30 seconds, or once it has failed and reported 1,000 emails (`email.failed` runs the project's
    workflows); queueing an email again, and failing one without a report, is not counted. It works through at least
    the first batch of each page it reads before it looks at the time, so a slow read cannot keep every run from
    getting anywhere. The run that reaches the end of a pass removes its place, and the next run starts it over.
  - A job that holds an SES acceptance runs again, which records it, however old the email.
  - An email created `EMAIL_STALL_SWEEP_MAX_AGE_HOURS` (default `24`, from `1` to `8760`) or longer ago is failed
    without being sent and without `email.failed`: a `PENDING` one as not sent, a `SENDING` one as an unknown outcome.
    On a database an upstream version used, the first runs so fail the emails it left behind (a job lost from Redis
    leaves an email `PENDING` there, a worker restarted mid-send `SENDING`), instead of sending them months late,
    with bodies upstream's 90-day cleanup emptied.
  - Otherwise a job that failed for good settles its email as D22's `settleFailedJob` does; a `PENDING` email is
    queued again with the priority it was sent with (a finished job under its ID is removed first), unless its project
    is disabled, which fails it without a report as disabling the project does; any other `SENDING` email is failed as
    an unknown outcome (`stalled_without_checkpoint`). A failure on one email does not stop the others.
  - `EMAIL_STALL_SWEEP_ENABLED=false` turns the sweep off (the runs do nothing). Both variables are read by the worker,
    and any other value stops the API and the worker at startup. The bundled `docker-compose.yml` passes both.
  - D22's `settleFailedJob` now leaves a `SENDING` email claimed less than 2 minutes ago to the sweep, as the run that
    claimed it may still record it as sent, and says what it did.
  - A workflow email whose job could not be queued fails its step and execution, as before, but is now sent by the
    sweep, usually 15 to 20 minutes later.
- **Known issue:** the age limit applies to campaign emails too: a campaign that takes longer than
  `EMAIL_STALL_SWEEP_MAX_AGE_HOURS` to send, whose jobs Redis loses past that age, has its remaining emails failed
  without a report and finishes with them unsent. Exempting campaigns still `SENDING` would send the leftovers of a
  campaign an upstream version left stuck in `SENDING`; raise the limit for campaigns that take days.
- **Why:** an email left without a job was never sent, failed or recorded, and a campaign waiting on it never
  finished.
- **Remove when:** upstream settles emails left without a job.

### D27 — A short render budget for the API's pass over a send

- **Since:** 2026-10-07
- **Kind:** fix
- **Upstream:** not proposed
- **Files:**
  - `packages/shared/src/template/index.ts`
  - `packages/shared/src/__tests__/template.renderBudget.test.ts`
  - `apps/api/src/services/TransactionalSendService.ts`
  - `apps/api/src/controllers/__tests__/Actions.send.test.ts`
  - `apps/wiki/content/docs/guides/template-language.mdx`
- **What:** builds on D16 and D20. Since upstream's `f3cd82c`, the API renders the subject and body of every email of
  `/v1/send` with Liquid while the request waits, with the worker's budget of 1 s per template, and parses them again
  for each recipient: a template that exhausts the budget costs it once per recipient when it is longer than the
  200,000 characters the parse cache keeps.
  - A send's subject and body are parsed once, when the request is prepared, and rendered for each recipient with a
    budget of 50 ms (`SEND_RENDER_LIMIT_MS`). A template that exhausts it is skipped by Liquid for the rest of the
    send (since D28, stored as written for the worker; before, filled in by the fallback renderer).
    `/v1/send/batch` prepares each of its emails the same way.
  - `CompiledTemplate.render` takes an optional budget (`renderLimitMs`, by default `TEMPLATE_RENDER_LIMIT_MS`). A
    template that failed within a budget skips Liquid for that budget and smaller ones only, so a failure at the API
    does not send the 1 s renders of the same template (the worker's, and the API's for workflows and campaigns) to
    the fallback renderer.
  - A `/v1/send` request now holds the event loop for about 100 ms of rendering at most, however many recipients it
    has, and a batch of 100 emails with distinct such templates for about 10 s, down from about 200 s.
- **Known issue:** since D28, a template that needs more than 50 ms is stored as written and rendered once by the worker,
  with its 1 s budget, against the contact's stored data only: request data sent with `persistent: false` is not
  available to it. The template guide says so. (Before D28, the API filled it in with the fallback renderer, which
  emptied placeholders inside loops, and the worker ran its tags in a second pass.)
- **Why:** with upstream's budget, one request with a valid key could hold the API's event loop for minutes.
- **Remove when:** upstream bounds the render time of its API pass.

### D28 — Every email is rendered once

- **Since:** 2026-10-15
- **Kind:** fix
- **Upstream:** not proposed
- **Files:**
  - `packages/shared/src/template/index.ts`
  - `packages/shared/src/__tests__/template.escapeHtml.test.ts`
  - `apps/api/src/services/CampaignService.ts`
  - `apps/api/src/services/WorkflowExecutionService.ts`
  - `apps/api/src/services/TransactionalSendService.ts`
  - `apps/api/src/services/EmailService.ts`
  - `apps/api/src/services/EmailHeaderService.ts`
  - `apps/api/src/jobs/email-processor.ts`
  - `apps/api/src/services/__tests__/renderOnce.test.ts`
  - `apps/api/src/controllers/__tests__/Actions.send.test.ts`
  - `apps/wiki/content/docs/guides/template-language.mdx`
  - `apps/wiki/content/docs/guides/unsubscribe-pages.mdx`
- **What:** builds on D18 and D27. Upstream renders the subject and body of a campaign, workflow or `/v1/send` email
  when it queues it, then the worker renders the stored result again, so a value the first pass inserted (a contact's
  name, an event's data, a `/v1/track` field anyone can set) is read as template code by the second.
  - The sender renders each email once, with an id it chooses first (`randomUUID`, or the idempotency claim's id for
    `/v1/send`), and stores it with `X-Plunk-Templating: off` (`renderedEmailHeaders`), so the worker sends it as it is.
    `EmailService.subscriptionUrls` attributes `unsubscribeUrl`, `subscribeUrl` and `manageUrl` to that id (`?e=`). This
    changes behavior: upstream's first pass filled them in before the email existed, so links in campaign, workflow and
    `/v1/send` bodies were unattributed, and an unsubscribe through one now counts towards the campaign's
    `unsubscribedCount`, like one through the footer. Each path keeps its variables otherwise; the worker's pass gains
    `id`.
  - `CompiledTemplate.renderWithin` renders within a budget or returns `undefined`. `/v1/send` stores a template it cannot
    render within its 50 ms (D27) as written, without the header, and the worker renders it once with its own budget
    against the contact's stored data. A failure within a budget below the worker's is latched on the compiled template
    of that send only, not on the shared parse, so one send's oversized data never decides how a later send of the
    template renders (D27 latched it on the parse).
  - The worker still renders emails stored without the header: those queued before this change, and the case above.
  - `sendTransactionalEmail` keeps an email it cannot queue only when its id comes from an idempotency claim (`claimed`),
    since every send now passes an id.
- **Why:** the second pass ran template code from data (`{% for %}` loops in a name, `{{ }}` lookups of other fields),
  and undid `{% raw %}`.
- **Remove when:** upstream renders each email once.

### D29 — HTML-escaped template variables, per project

- **Since:** 2026-10-15
- **Kind:** feature
- **Upstream:** not proposed
- **Files:**
  - `packages/shared/src/template/engine.ts`
  - `packages/shared/src/template/index.ts`
  - `packages/shared/src/template/legacy.ts`
  - `packages/shared/src/schemas/index.ts`
  - `packages/shared/src/__tests__/template.escapeHtml.test.ts`
  - `packages/db/prisma/schema.prisma`
  - `packages/db/prisma/migrations/20261014230143_fork_project_escape_variables/`
  - `apps/api/src/services/CampaignService.ts`
  - `apps/api/src/services/WorkflowExecutionService.ts`
  - `apps/api/src/services/TransactionalSendService.ts`
  - `apps/api/src/services/EmailService.ts`
  - `apps/api/src/jobs/email-processor.ts`
  - `apps/api/src/services/__tests__/renderOnce.test.ts`
  - `apps/api/src/controllers/__tests__/Actions.send.test.ts`
  - `apps/api/src/controllers/__tests__/Actions.sendBatch.test.ts`
  - `apps/web/src/pages/settings/index.tsx`
  - `apps/web/src/components/EmailEditor/EmailEditor.tsx`
  - `apps/wiki/content/docs/guides/template-language.mdx`
- **What:** a project setting, **Escape HTML in variables** (`Project.escapeVariables`, column `fork_escape_variables`, default `false`, editable through
  `PATCH /users/@me/projects/:id` and the settings page). When it is on, every output of an email body is HTML-escaped
  (`compileTemplate(source, {escapeHtml: true})`, Liquid's `outputEscape` hook; array items are escaped one by one, the
  fallback renderer escapes too), and `{{ value | raw }}` opts out (`raw` as the last filter). Subjects are never
  escaped. Applies to campaigns, workflows, `/v1/send`, the worker's own pass and the editor's preview.
  - The escape leaves text escaped already as it is (`escape_once` semantics), so `| escape` and `{% capture %}` do not
    escape twice.
  - The escaping engine refuses `{% echo %}`, `{% liquid %}` and `{% cycle %}`, which write values without the hook; a
    template that uses them falls back to plain placeholder substitution, escaped.
- **Why:** a variable that holds third-party text (event data, a name typed into a sign-up form) otherwise puts markup
  and links into the email.
- **Remove when:** upstream offers escaped variables.

### D30 — Batch contact upsert, and contact ids from lookups

- **Since:** 2026-10-15
- **Kind:** feature
- **Upstream:** not proposed
- **Files:**
  - `packages/shared/src/schemas/index.ts`
  - `apps/api/src/services/ContactService.ts`
  - `apps/api/src/controllers/Contacts.ts`
  - `apps/api/src/middleware/rateLimit.ts`
  - `apps/api/src/middleware/__tests__/rateLimit.test.ts`
  - `apps/api/src/services/__tests__/ContactService.upsertMany.test.ts`
  - `apps/wiki/openapi.json`
  - `apps/wiki/content/docs/concepts/contacts.mdx`
  - `apps/wiki/content/docs/api-reference/overview.mdx`
  - `apps/wiki/content/docs/self-hosting/environment-variables.mdx`
- **What:**
  - `POST /contacts/batch` upserts up to 100 contacts (`ContactService.upsertMany`), each by the rules of
    `POST /contacts` (stricter input: valid emails, `data` an object), and answers
    `{contacts: [{id, email, subscribed, created}]}` in request order, emails normalized.
    - Each contact is one `INSERT … ON CONFLICT ("projectId", "email") DO UPDATE` that merges the data in the database
      (`(data - deleted keys) || set keys`), so two batches writing one contact never lose each other's keys. Other
      writers (`upsert`, `PATCH`) still read then write the whole object.
    - A `MATERIALIZED … FOR UPDATE` CTE locks the existing row before the write and reads its committed `subscribed`,
      so a concurrent change cannot make the subscription event wrong. Two batches creating the same new address at
      once can still miss an event (the losing write has no previous state).
    - Timestamps are written as UTC (`now() AT TIME ZONE 'UTC'`), as Prisma writes them.
    - The batch is one transaction (10 s to start, 30 s to finish), written in email order so that overlapping
      batches lock in the same order. An address listed twice is a `ValidationError` naming each repeated entry.
    - Subscription changes record `contact.subscribed` or `contact.unsubscribed` after the commit, each on its own,
      so a failed event is logged and fails neither the request nor the other events.
    - `mergeContactData`'s rules move into `contactDataPatch`, which both paths use.
  - Rate limiting: a bucket can charge a request more than one token (`RateLimitBucket.cost`, capped at the burst;
    the token-bucket script takes the cost). The batch charges the shared `contacts:write` budget one token per
    contact.
  - `POST /contacts/lookup` also returns `contacts: [{email, id}]` for the addresses found, so a caller can address
    a contact by id (`PATCH /contacts/:id`, for example to change its email) without the contact search.
- **Known issue:** another bulk writer that locks contacts in a different order (bulk subscribe, the snooze sweep)
  can deadlock with a batch; Postgres aborts one side, and the batch answers `500` and can be retried.
- **Why:** keeping an external system's records in Plunk otherwise takes one request per contact, and renaming a
  contact needs its id, which only the slow search returned.
- **Remove when:** upstream ships a bulk upsert and ids from lookups.

### D31 — Array operators in segments

- **Since:** 2026-10-15
- **Kind:** feature
- **Upstream:** not proposed
- **Files:**
  - `packages/types/src/segments/index.ts`
  - `packages/shared/src/schemas/index.ts`
  - `packages/shared/src/operators.ts`
  - `apps/api/src/services/SegmentService.ts`
  - `apps/api/src/services/ContactService.ts`
  - `apps/api/src/services/WorkflowService.ts`
  - `apps/api/src/controllers/Contacts.ts`
  - `apps/api/src/services/__tests__/SegmentService.arrayOperators.test.ts`
  - `apps/mcp/src/schemas.ts`
  - `apps/web/src/components/SegmentFilterBuilder.tsx`
  - `apps/web/src/components/SegmentRuleSummary.tsx`
  - `apps/web/src/components/DataManagementSettings.tsx`
  - `apps/web/src/components/EmailEditor/VariableMention.ts`
  - `apps/web/src/lib/hooks/useContacts.ts`
  - `apps/wiki/openapi.json`
  - `apps/wiki/content/docs/guides/segment-filters.mdx`
  - `apps/wiki/content/docs/guides/custom-fields.mdx`
  - `apps/wiki/content/docs/concepts/contacts.mdx`
- **What:** segment filters (and so campaign audiences) on a `data.<key>` that holds an array.
  - `includesAny`, `includesAll` and `includesNone` take a list of 1 to 100 JSON scalars (a single value counts as a
    list of one; a list with any other item is refused, not trimmed) and compile to Prisma's `array_contains`
    (jsonb `@>`): `includesAny` is an `OR` of one-item containments, `includesAll` one containment of all items,
    `includesNone` an array (`@> []`) that contains none of them, so it never matches a missing field or a
    non-array. Items compare as JSON values. Only `data.*` fields take them; workflow conditions don't. The REST
    API reference and the MCP server's filter schema list them.
  - `GET /contacts/fields` types a field `array` when any contact holds an array in it (upstream types a field from
    one sample, as `string` for an array, which offered `contains`, a substring match that never matches an array),
    and reports the JSON type of its items (`itemType`). The workflow field list keeps reporting it as `string`.
  - The segment builder offers the array operators for such fields. Their values are typed comma-separated in an
    input that keeps its own text, and sent typed: an entry the list held keeps its JSON type, a new one takes the
    field's item type. A filter saved with an operator its field no longer offers still shows it. Segment cards
    summarize the operators (`has any of`, `has all of`, `has none of`).
- **Why:** contact data commonly holds lists (languages, tags, interests), and no upstream operator can filter on an
  item of one.
- **Remove when:** upstream ships array operators.

### D32 — Topics

- **Since:** 2026-10-15
- **Kind:** feature
- **Upstream:** not proposed
- **Files:**
  - `packages/db/prisma/schema.prisma`
  - `packages/db/prisma/migrations/20261014232707_fork_topics/`
  - `packages/shared/src/schemas/index.ts`
  - `packages/types/src/api/campaign.ts`
  - `apps/api/src/app.ts`
  - `apps/api/src/controllers/Topics.ts`
  - `apps/api/src/controllers/Campaigns.ts`
  - `apps/api/src/controllers/Contacts.ts`
  - `apps/api/src/services/TopicService.ts`
  - `apps/api/src/services/CampaignService.ts`
  - `apps/api/src/services/ContactService.ts`
  - `apps/api/src/services/SegmentService.ts`
  - `apps/api/src/services/TransactionalSendService.ts`
  - `apps/api/src/services/WorkflowExecutionService.ts`
  - `apps/api/src/services/WorkflowService.ts`
  - `apps/api/src/services/__tests__/topics.test.ts`
  - `apps/web/src/components/TopicsSettings.tsx`
  - `apps/web/src/components/CampaignTopicSelect.tsx`
  - `apps/web/src/components/ContactTopics.tsx`
  - `apps/web/src/components/SegmentFilterBuilder.tsx`
  - `apps/web/src/components/SegmentRuleSummary.tsx`
  - `apps/web/src/pages/segments/index.tsx`
  - `apps/web/src/pages/settings/index.tsx`
  - `apps/web/src/pages/campaigns/create.tsx`
  - `apps/web/src/pages/campaigns/[id].tsx`
  - `apps/web/src/pages/contacts/[id].tsx`
  - `apps/mcp/src/schemas.ts`
  - `apps/mcp/src/tools/campaigns.ts`
  - `apps/wiki/.gitignore`
  - `apps/wiki/openapi.json`
  - `apps/wiki/content/docs/api-reference/meta.json`
  - `apps/wiki/content/docs/concepts/meta.json`
  - `apps/wiki/content/docs/concepts/topics.mdx`
  - `apps/wiki/content/docs/concepts/campaigns.mdx`
  - `apps/wiki/content/docs/guides/segment-filters.mdx`
- **What:** a project setting, **Topics** (`Project.topicsEnabled`, column `fork_topics_enabled`, default `false`),
  under which every campaign is sent for one topic and contacts subscribe to topics one by one.
  - **Model:** `Topic` (`fork_topics`: `slug` unique per project, `name`, `description`, `basis` `OPT_OUT` or
    `OPT_IN` (`fork_topic_basis`), `campaignSelectable`, `listId`) and `ContactTopic` (`fork_contact_topics`: a
    contact's explicit state for a topic). A contact's effective subscription is its explicit state, or without one
    the basis (`TopicService.subscribedWhere`). `Campaign.topicId` (`fork_topic_id`, `SET NULL` when the topic is
    deleted).
  - **API:** `GET /topics`, `PUT /topics/:slug` (create or update), `DELETE /topics/:slug`; `GET` and
    `PUT /contacts/:id/topics` (explicit states by slug, `null` lets the basis decide); `POST /contacts/batch` takes a
    `topics` object per contact (D30), refused whole on an unknown slug; campaigns take `topicId`.
  - **Campaigns** with a topic: the audience is narrowed to the contacts subscribed to it (`AND`, after upstream's
    audience, `subscribed = true` included), also after the project turned topics off, so turning them off never
    widens a scheduled or sending campaign. In a project with topics, a campaign without a topic, with a topic
    campaigns cannot use, or of the `TRANSACTIONAL` type reaches nobody, whatever path sends it; create and update
    refuse `TRANSACTIONAL` and an unusable topic, a scheduled campaign keeps its topic, send refuses a campaign
    without one, and a scheduled campaign that has none when it is due goes back to a draft rather than sending to
    nobody. Without topics, a campaign keeps the topic it has but takes no new one. A topic's `listId` is stored on
    each campaign email as its `List-Id` header. Batches of an audience bound the topic states they read by the
    cursor, on the `(topicId, subscribed, contactId)` index.
  - **Topics:** `PUT` changes only the fields given; `DELETE` answers `409` while a scheduled or sending campaign is
    sent for the topic, or a segment or such a campaign filters on it. `listId` is printable ASCII with a dotted id.
  - **Segments:** `topic.<topicId>` with `equals`/`notEquals` and a boolean filters on the effective subscription;
    segments and campaign audiences refuse another project's topic.
  - **Transactional contacts:** a second project setting, **Subscribe contacts created by transactional sends**
    (`Project.subscribeTransactionalContacts`, column `fork_subscribe_transactional_contacts`, default `false`), makes
    `/v1/send` create contacts subscribed, so that `subscribed` only means "not suppressed" where topics hold the
    consent (upstream: unsubscribed).
  - **Workflows and `/v1/send`** in a project with topics send transactional templates only: enabling a workflow
    with a marketing or headless send step, adding such a step to an enabled workflow, and `/v1/send` (and
    `/v1/send/batch`) with such a template are refused, and the send step refuses such a template whatever enabled
    the workflow. A send without a template is the caller's transactional mail.
  - **MCP:** `plunk_create_campaign` takes `topicId`; the filter field help names `topic.<topicId>`.
  - **Dashboard:** a Topics settings tab (the switch, and topics to add, edit and delete), a topic picker on the
    campaign create and edit pages (which hide the transactional type and explain a transactional draft from before),
    a Topics card with switches on the contact page, topics as yes/no fields in the segment builder (`equals` and
    `notEquals` only), and segment cards that name them (`Product news subscribed`).
- **Known issues:** topic state changes through the API and the dashboard track no events. Contacts a transactional
  send created unsubscribed before stay out of every campaign, whatever their topic states say.
- **Why:** with one `subscribed` flag, a contact who unsubscribes from one kind of marketing mail loses all of it,
  and a project has no way to send each kind to its own audience of consent.
- **Remove when:** upstream ships topics or subscription lists.

### D33 — Topic unsubscribes, your own unsubscribe page, and the report-back

- **Since:** 2026-10-15
- **Kind:** feature
- **Upstream:** not proposed (upstream issue 421 asks for bring-your-own one-click unsubscribe)
- **Files:**
  - `packages/db/prisma/schema.prisma`
  - `packages/db/prisma/migrations/20261015090000_fork_unsubscribe_url_template/`
  - `packages/shared/src/schemas/index.ts`
  - `packages/shared/src/i18n/locales/bg.json`
  - `packages/shared/src/i18n/locales/cs.json`
  - `packages/shared/src/i18n/locales/cy.json`
  - `packages/shared/src/i18n/locales/de.json`
  - `packages/shared/src/i18n/locales/en.json`
  - `packages/shared/src/i18n/locales/es.json`
  - `packages/shared/src/i18n/locales/fr.json`
  - `packages/shared/src/i18n/locales/hi.json`
  - `packages/shared/src/i18n/locales/it.json`
  - `packages/shared/src/i18n/locales/ja.json`
  - `packages/shared/src/i18n/locales/nl.json`
  - `packages/shared/src/i18n/locales/pl.json`
  - `packages/shared/src/i18n/locales/pt.json`
  - `packages/shared/src/i18n/locales/sv.json`
  - `packages/shared/src/i18n/locales/zh-CN.json`
  - `packages/shared/src/i18n/locales/zh-HK.json`
  - `packages/shared/src/i18n/locales/zh-TW.json`
  - `apps/api/src/services/ListManagementUrls.ts`
  - `apps/api/src/services/ListManagementService.ts`
  - `apps/api/src/services/ContactService.ts`
  - `apps/api/src/services/EmailService.ts`
  - `apps/api/src/services/EmailHeaderService.ts`
  - `apps/api/src/services/CampaignService.ts`
  - `apps/api/src/services/TransactionalSendService.ts`
  - `apps/api/src/services/WorkflowExecutionService.ts`
  - `apps/api/src/jobs/email-processor.ts`
  - `apps/api/src/services/EmailAssembly.ts`
  - `apps/api/src/controllers/Unsubscribe.ts`
  - `apps/api/src/controllers/Contacts.ts`
  - `apps/api/src/controllers/Emails.ts`
  - `apps/api/src/controllers/Users.ts`
  - `apps/api/src/services/__tests__/listManagement.test.ts`
  - `apps/api/src/jobs/__tests__/email-processor.unsubscribeUrl.test.ts`
  - `apps/api/src/controllers/__tests__/Unsubscribe.test.ts`
  - `apps/web/src/components/list-management/ListManagement.tsx`
  - `apps/web/src/lib/snooze.ts`
  - `apps/web/src/pages/unsubscribe/[id].tsx`
  - `apps/web/src/pages/manage/[id].tsx`
  - `apps/web/src/pages/settings/index.tsx`
  - `apps/web/src/components/TopicsSettings.tsx`
  - `apps/web/src/components/CampaignTopicSelect.tsx`
  - `apps/wiki/openapi.json`
  - `apps/wiki/content/docs/api-reference/meta.json`
  - `apps/wiki/content/docs/guides/unsubscribe-pages.mdx`
  - `apps/wiki/content/docs/concepts/topics.mdx`
  - `apps/wiki/content/docs/guides/webhooks.mdx`
- **What:**
  - **Topic unsubscribes (D32 projects):** an unsubscribe from an email of a campaign with a topic drops that topic
    only. Plunk's one-click `POST /unsubscribe/:id?e=` sets the contact's state for the topic to unsubscribed; the
    hosted unsubscribe page asks about the topic and offers "Unsubscribe from all emails" and "Subscribe again"; the
    preferences page has a switch per topic. `GET /contacts/public/:id?e=` returns `topics` and the email's `topic`,
    and `POST /contacts/public/:id/{subscribe,unsubscribe}` take `{"topic": "<slug>"}`. A change from the effective
    state tracks `contact.unsubscribed` / `contact.subscribed` with `topic` in its data, attributed to the email.
    Leaving the topic the email was sent for counts against its campaign (`unsubscribedCount`); leaving another topic
    does not. Without a topic, everything behaves as upstream.
  - **One unsubscribe per email:** the first recorded unsubscribe from an email (`Email.unsubscribeCountedAt`, column
    `fork_unsubscribe_counted_at`, claimed with a conditional update) is the one counted against its campaign, on
    every path: upstream's page unsubscribe and snooze, the topic paths and the report-back. Upstream counted every
    page unsubscribe and snooze, so leaving a topic, then everything, counted twice.
  - **Unsubscribe URL template:** a project setting, **Unsubscribe URL** (`Project.unsubscribeUrlTemplate`, column
    `fork_unsubscribe_url_template`, nullable), a Liquid template validated on save. When set, the URL it renders for
    each email (scope: the contact as in an email, `emailId`, and `topic` with `id`, `slug`, `name`) is the email's
    `{{unsubscribeUrl}}`, `{{subscribeUrl}}` and `{{manageUrl}}`, the marketing footer's link, and the target of
    `List-Unsubscribe` (with `List-Unsubscribe-Post` for an `https` URL only). The result must be an absolute http(s)
    URL with a plain host, of at most 900 characters (the header is one line); the URL parser's form is used, with
    single quotes encoded too, so it fits a header and a quoted attribute. Saving refuses a template that starts with
    neither `http(s)://` nor a Liquid tag. A marketing email it renders no URL for fails (`unsubscribe_url_missing`)
    rather than going out without a way out. Workflow webhooks render it without an email.
  - **Plunk's pages off:** with the template set, `/contacts/public/:id` and its subscribe, unsubscribe and snooze
    routes answer `404 Contact not found`, as for an unknown contact. Links of older mail that name an email of the
    contact (`e`) go to the URL the template renders for that email: `GET /unsubscribe/:id` with `302`, and
    `GET /contacts/public/:id` with `{"redirect": url}`, which the hosted pages follow. A one-click `POST` of older
    mail still unsubscribes in Plunk and answers `200` (RFC 8058 asks for no redirect).

  - **Report-back:** `POST /v1/emails/:id/unsubscribed` (secret key) with `{topic?: slug | null, email?}` unsubscribes
    the email's contact from the topic (default: the email's campaign topic; `null`: every email), after checking
    `email` against the recipient when given. The email's own unsubscribe is tracked as `contact.unsubscribed` and
    counted against its campaign once per email (unless the email bounced or was complained about); a report of
    another topic is applied, not counted.
- **Why:** a project with topics needs an unsubscribe that drops one topic, and a sender that keeps consent in its
  own product needs Plunk's links and `List-Unsubscribe` to point at its own page, without Plunk's pages writing
  consent behind its back, while campaign stats still count the unsubscribes its page took.
- **Remove when:** upstream ships topic unsubscribes, a custom unsubscribe URL and a way to report an unsubscribe.

### D34 — Layouts, CSS inlining and the editor's button

- **Since:** 2026-10-15
- **Kind:** feature
- **Upstream:** not proposed
- **Files:**
  - `apps/api/package.json`
  - `yarn.lock`
  - `apps/api/src/app.ts`
  - `apps/api/src/controllers/Campaigns.ts`
  - `apps/api/src/controllers/Layouts.ts`
  - `apps/api/src/controllers/Templates.ts`
  - `apps/api/src/jobs/email-processor.ts`
  - `apps/api/src/services/EmailAssembly.ts`
  - `apps/api/src/jobs/__tests__/email-processor.layout.test.ts`
  - `apps/api/src/services/CampaignService.ts`
  - `apps/api/src/services/EmailHeaderService.ts`
  - `apps/api/src/services/EmailService.ts`
  - `apps/api/src/services/LayoutService.ts`
  - `apps/api/src/services/TemplateService.ts`
  - `apps/api/src/services/TransactionalSendService.ts`
  - `apps/api/src/services/WorkflowExecutionService.ts`
  - `apps/api/src/services/__tests__/layouts.test.ts`
  - `apps/mcp/src/tools/campaigns.ts`
  - `apps/mcp/src/tools/templates.ts`
  - `apps/web/src/components/EmailEditor/EmailButton.ts`
  - `apps/web/src/components/EmailEditor/EmailEditor.tsx`
  - `apps/web/src/components/EmailEditor/Toolbar.tsx`
  - `apps/web/src/components/LayoutSelect.tsx`
  - `apps/web/src/components/LayoutsSettings.tsx`
  - `apps/web/src/lib/emailStyles.ts`
  - `apps/web/src/lib/__tests__/emailStyles.test.ts`
  - `apps/web/src/lib/hooks/useLayouts.ts`
  - `apps/web/src/pages/campaigns/[id].tsx`
  - `apps/web/src/pages/campaigns/create.tsx`
  - `apps/web/src/pages/settings/index.tsx`
  - `apps/web/src/pages/templates/[id].tsx`
  - `apps/web/src/pages/templates/create.tsx`
  - `apps/wiki/.gitignore`
  - `apps/wiki/openapi.json`
  - `apps/wiki/content/docs/api-reference/meta.json`
  - `apps/wiki/content/docs/concepts/meta.json`
  - `apps/wiki/content/docs/concepts/layouts.mdx`
  - `packages/db/prisma/schema.prisma`
  - `packages/db/prisma/migrations/20261015120000_fork_layouts/`
  - `packages/shared/src/index.ts`
  - `packages/shared/src/layout.ts`
  - `packages/shared/src/schemas/index.ts`
  - `packages/shared/src/__tests__/layout.test.ts`
  - `packages/types/src/api/campaign.ts`
  - `apps/wiki/content/docs/concepts/templates.mdx`
- **What:**
  - **Layouts:** `Layout` (`fork_layouts`: `slug` unique per project, `name`, `html` (up to 100,000 characters) with
    exactly one `{{ content }}` slot and valid Liquid, `css` (up to 50,000, as it is inlined into every email),
    `isDefault`, at most one per project), and `layoutId` on templates and campaigns
    (`fork_layout_id`, `SET NULL` when the layout is deleted). `GET /layouts`, `GET`/`PUT`/`DELETE /layouts/:slug`
    (an update changes only the fields given; delete answers `409` while a scheduled or sending campaign is in the
    layout). A template or campaign created without `layoutId` gets the project's default layout; `null` is none.
    Duplicates keep the layout.
  - **Sending:** the body is put into the slot before the email's one template pass (D28), for campaigns, workflow
    emails and `/v1/send` with a template (a send without a template is the caller's HTML, in no layout), and the
    email notes the layout in an internal header (`X-Plunk-Layout`). The worker finishes such an email: the layout's
    CSS, after Plunk's default `a.email-button` style, is inlined with `juice` (media queries and font faces stay in
    a `<style>` block), and a layout that links to `{{ unsubscribeUrl }}` or `{{ manageUrl }}` replaces Plunk's
    marketing footer once the rendered email shows that link in an `href` outside HTML comments. A worker keeps a
    layout for a minute, so its changes reach emails within one.
  - **The button:** a TipTap node (`emailButton`) writes `<p class="email-button-row"><a class="email-button">`.
    `email-button` joins the visual editor's class allowlist in both of its copies (`EmailService` and the web's
    `emailStyles`), so a body with a button stays editable, and both copies of the wrapper styles style it.
  - **Dashboard:** a Layouts settings tab (add, edit with a starter layout, default, delete), a layout picker on the
    template and campaign create and edit pages (a campaign started from a template or campaign takes its layout),
    and the editor's preview inside the picked layout with its CSS.
  - **Known issues:** "one default per project" is kept by a transaction, not by a database constraint, so two
    concurrent writes can leave two (the newest is used). Previews outside the editor (activity, sent campaigns) show
    the stored body without the layout's CSS.
  - **Dependency:** `juice` for the API, at the version range the dashboard already uses (`^11.0.3`).
  - **MCP:** `plunk_create_campaign` and `plunk_create_template` take `layoutId`.
- **Why:** upstream wraps a visual body in its own prose styles only, so a sender cannot send in its own design, and
  CSS in a `<style>` block is dropped by many mail clients.
- **Remove when:** upstream ships layouts and CSS inlining.

### D35 — Test sends rendered as they go out

- **Since:** 2026-10-15
- **Kind:** feature
- **Upstream:** not proposed
- **Files:**
  - `apps/api/src/services/EmailAssembly.ts`
  - `apps/api/src/services/CampaignService.ts`
  - `apps/api/src/services/EmailService.ts`
  - `apps/api/src/services/LayoutService.ts`
  - `apps/api/src/jobs/email-processor.ts`
  - `apps/api/src/controllers/Campaigns.ts`
  - `apps/api/src/services/__tests__/testSends.test.ts`
  - `apps/api/src/services/__tests__/testSends.parity.test.ts`
  - `apps/wiki/content/docs/api-reference/overview.mdx`
  - `packages/shared/src/schemas/index.ts`
  - `apps/web/src/pages/campaigns/[id].tsx`
  - `apps/wiki/content/docs/concepts/campaigns.mdx`
- **What:** `POST /campaigns/:id/test` (still to project members only, `[TEST]` subject, tracking off) renders the
  email as it would really go out, where upstream sent the raw body: the subject and body rendered as a contact
  (`contactId`, of the project; by default the member's own contact, else sample data with their address), the body
  in the campaign's layout (D34), Plunk's wrapper, footer and badge, the topic's `List-Id` (D32) and
  `List-Unsubscribe` with the project's own URL when it has one (D33). Nothing is recorded. A test whose unsubscribe
  URL template renders no URL answers `400`, as the real email would fail. The list-management links are always the
  member's own contact's (dead links for sample data), never the rendered contact's, so a test cannot unsubscribe a
  customer. The worker's last steps (layout CSS, footer, wrapper and headers) moved into `assembleEmail`, which the
  worker and the test share; a parity test checks that a test equals the member's real email but for the email id,
  the subject marker and `X-Plunk-Test`. The dashboard's test dialog picks the contact (**Render as**, searched only
  while the dialog is open).
- **Why:** a test that skips variables, layout and footer cannot be reviewed before a campaign goes out.
- **Remove when:** upstream renders test sends.

### D36 — Campaign pacing and the campaign email priority

- **Since:** 2026-10-15
- **Kind:** feature
- **Upstream:** not proposed
- **Files:**
  - `packages/db/prisma/schema.prisma`
  - `packages/db/prisma/migrations/20261015150000_fork_campaign_pacing/`
  - `packages/shared/src/pacing.ts`
  - `packages/shared/src/index.ts`
  - `packages/shared/src/schemas/index.ts`
  - `packages/types/src/api/campaign.ts`
  - `packages/types/src/jobs/campaign.ts`
  - `apps/api/src/app/constants.ts`
  - `apps/api/src/services/CampaignService.ts`
  - `apps/api/src/services/QueueService.ts`
  - `apps/api/src/jobs/campaign-processor.ts`
  - `apps/api/src/controllers/Campaigns.ts`
  - `apps/api/src/services/__tests__/pacing.test.ts`
  - `apps/mcp/src/tools/campaigns.ts`
  - `apps/web/src/components/CampaignPacingField.tsx`
  - `apps/web/src/pages/campaigns/create.tsx`
  - `apps/web/src/pages/campaigns/[id].tsx`
  - `apps/api/.env.example`
  - `.env.self-host.example`
  - `apps/wiki/openapi.json`
  - `apps/wiki/content/docs/concepts/campaigns.mdx`
  - `apps/wiki/content/docs/self-hosting/environment-variables.mdx`
- **What:**
  - **Pacing:** a campaign may cap its recipients per hour (`Campaign.sendsPerHour`, column `fork_sends_per_hour`,
    nullable; `sendsPerHour` on create and update, 1 to 1,000,000). A paced campaign's batches take a twelfth of the
    cap (at most the chain's 500), and the next batch is queued with the delay that batch's share of the hour takes
    (`QueueService.queueCampaignBatch` takes a delay). Emails are still created per batch, so none waits in the queue
    long enough for the stall sweep (D25). Duplicates keep the cap. The cap is the one field a sending campaign can
    still change (`PUT` with only `sendsPerHour`), for the batches that follow. The campaign pages have a **Pacing**
    field (also while sending), and the send and schedule dialogs show how long the saved campaign's send takes; they
    wait for unsaved changes. The batch math is in `@plunk/shared` (`pacing.ts`), for the API and the dashboard.
  - **The chain, made safe for long gaps between batches:**
    - Pages start after the cursor's id (`id > cursor` in the `where`). Upstream's Prisma `cursor` with `skip: 1`
      skipped the next recipient whenever the cursor's contact had left the audience (bounced, unsubscribed, or below
      D32's topic bound, which always excludes it), and ended the chain when it was deleted. Rare upstream, routine
      with paced batches minutes apart.
    - While batches remain, `totalRecipients` is kept above the recipients reached (the job carries `reached`), so
      `finalizeIfDone` cannot finish a campaign whose audience grew since the send started; the last batch still sets
      the real count.
    - Batch jobs carry the send's token (the campaign's `sentAt`) in their data and id: a batch left over from a send
      that was cancelled and sent again is skipped, and the new send's job ids never collide with the old ones.
      Batches queued before the change carry none and run as before.
  - **Priority:** `CAMPAIGN_EMAIL_PRIORITY` (env, 2 to 2,097,152, default upstream's `10`) sets campaign emails' queue
    priority, so a deployment can let `/v1/send`'s `low` priority (also 10) pass large campaigns; transactional email
    (1) always goes first.
- **Why:** a large campaign from a sending domain that is still warming up goes out all at once upstream, and ties
  with low-priority transactional sends in the queue.
- **Remove when:** upstream paces campaigns and makes their priority configurable.

### D37 — Scoped API keys

- **Since:** 2026-10-15
- **Kind:** feature
- **Upstream:** not proposed
- **Files:**
  - `packages/db/prisma/schema.prisma`
  - `packages/db/prisma/migrations/20261015200000_fork_scoped_api_keys/`
  - `packages/shared/src/apiKeys.ts`
  - `packages/shared/src/index.ts`
  - `packages/shared/src/schemas/index.ts`
  - `packages/types/src/auth/index.ts`
  - `apps/api/src/app.ts`
  - `apps/api/src/middleware/auth.ts`
  - `apps/api/src/middleware/__tests__/scopedApiKeys.test.ts`
  - `apps/api/src/middleware/__tests__/scopedApiKeys.routes.test.ts`
  - `apps/api/src/services/ApiKeyService.ts`
  - `apps/api/src/services/ApiKeyScopes.ts`
  - `apps/api/src/controllers/ApiKeys.ts`
  - `apps/api/src/utils/keyAttribution.ts`
  - `apps/api/src/services/CampaignService.ts`
  - `apps/api/src/services/TemplateService.ts`
  - `apps/api/src/services/SegmentService.ts`
  - `apps/api/src/controllers/Campaigns.ts`
  - `apps/api/src/controllers/Templates.ts`
  - `apps/api/src/controllers/Segments.ts`
  - `apps/web/src/lib/hooks/useApiKeys.ts`
  - `apps/web/src/components/ScopedApiKeys.tsx`
  - `apps/web/src/components/KeyAttribution.tsx`
  - `apps/web/src/pages/settings/index.tsx`
  - `apps/web/src/pages/campaigns/[id].tsx`
  - `apps/web/src/pages/templates/[id].tsx`
  - `apps/web/src/pages/segments/[id].tsx`
  - `apps/wiki/content/docs/guides/api-keys.mdx`
  - `apps/wiki/content/docs/api-reference/overview.mdx`
- **What:**
  - **Keys:** a project can have scoped keys besides its own two (`ApiKey`, table `fork_api_keys`): a name, scopes,
    the secret's first characters, and its SHA-256 hash. The secret (`sk_scoped_` and 48 hex characters) is shown
    once. A scoped key authenticates wherever the secret key does (`requireAuth`, `requireSecretKey`); its prefix tells
    it from a project's own key without a second lookup. `lastUsedAt` is written at most once a minute. Revoking sets
    `revokedAt`, and the key is refused at once; revoked keys stay, for the attribution that names them.
  - **Scopes, default deny:** `ApiKeyScopes.ts` lists, per route (`METHOD baseUrl+route.path`), the scopes that may
    call it, either outright or behind a check; every other route answers `403`, so a route upstream adds stays
    closed until it is listed. `draft` drafts marketing campaigns, templates, segments and layouts, test-sends (as
    the member's own contact), reads stats, domains and contact fields, and uploads images. It never lists contacts
    (it does see counts), and never changes what sends without a person: a campaign past DRAFT, a template a person
    made or a workflow sends, a tracked segment or one a scheduled or sending campaign or another segment uses, the
    default layout or one those use; it never turns tracking on or picks the default layout. `sync` covers the
    contact sync: batch upsert, lookup, delete, topics and contact topics, layouts, and the unsubscribe report-back
    (D33). A test checks every table entry against the controllers' real routes.
  - **Attribution:** campaigns, templates and segments get `createdByKeyId` and `updatedByKeyId` (columns
    `fork_created_by_key_id`, `fork_updated_by_key_id`; plain ids, no foreign key, since keys are never deleted). The
    controllers pass the key behind a create, update or duplicate; a change by a person or the project's own key
    clears `updatedByKeyId`; internal changes leave it. The dashboard shows the key's name on the three pages.
  - **Management:** `GET /api-keys` (members), `POST /api-keys` and `DELETE /api-keys/:id` (admins and owners), for
    people only; the settings page's General tab lists, creates (secret shown once) and revokes keys.
- **Why:** an agent or an integration should get a key that can do its job and nothing more: draft campaigns for a
  person to send, or keep contacts in step, without the project secret key that can send to everyone.
- **Remove when:** upstream has scoped API keys.

### D38 — Project avatars

- **Since:** 2026-10-15
- **Kind:** feature
- **Upstream:** not proposed
- **Files:**
  - `packages/db/prisma/schema.prisma`
  - `packages/db/prisma/migrations/20261015230000_fork_project_avatars/`
  - `packages/shared/src/schemas/index.ts`
  - `packages/shared/src/__tests__/projectAvatar.test.ts`
  - `apps/api/src/controllers/Users.ts`
  - `apps/api/src/controllers/__tests__/Users.avatar.test.ts`
  - `apps/web/src/components/ProjectAvatar.tsx`
  - `apps/web/src/components/DashboardLayout.tsx`
  - `apps/web/src/pages/account/index.tsx`
  - `apps/web/src/pages/settings/index.tsx`
- **What:** a project can have an avatar (`Project.avatarUrl`, column `fork_avatar_url`, nullable): an absolute
  http(s) image URL with a host, of up to 2,048 characters, stored normalized, set on the project update
  (`PATCH /users/@me/projects/:id`, `avatarUrl`; empty or `null` removes it). A URL on the API's host is refused
  (unless it is an upload's public URL): the avatar loads in every member's dashboard with their cookies, and a GET
  such as `/auth/logout` would act on it. The settings page's General tab sets it by upload, through the existing
  image upload when storage is configured, or by URL; either applies with the form's save. The dashboard shows it
  wherever it showed the project's initial (the project switcher and the account page's projects), and falls back
  to the initial without one or when the image does not load (a failed URL is not fetched again until a reload).
  The image loads without a referrer.
- **Why:** with several projects, an image tells them apart at a glance.
- **Remove when:** upstream has project avatars.

### D39 — Two-factor authentication: authenticator apps, passkeys and recovery codes

- **Since:** 2026-10-15
- **Kind:** feature
- **Upstream:** not proposed
- **Files:**
  - `packages/db/prisma/schema.prisma`
  - `packages/db/prisma/migrations/20261015233000_fork_two_factor/`
  - `packages/shared/src/schemas/index.ts`
  - `apps/api/package.json`
  - `apps/web/package.json`
  - `yarn.lock`
  - `apps/api/src/app.ts`
  - `apps/api/src/app/constants.ts`
  - `apps/api/src/services/Totp.ts`
  - `apps/api/src/services/TwoFactorService.ts`
  - `apps/api/src/services/keys.ts`
  - `apps/api/src/utils/session.ts`
  - `packages/types/src/api/twoFactor.ts`
  - `packages/types/src/api/index.ts`
  - `packages/email/src/emails/SecurityNotice.tsx`
  - `packages/email/src/emails/index.ts`
  - `apps/api/src/controllers/TwoFactor.ts`
  - `apps/api/src/controllers/Auth.ts`
  - `apps/api/src/controllers/Oauth/Github.ts`
  - `apps/api/src/controllers/Oauth/Google.ts`
  - `apps/api/src/services/__tests__/totp.test.ts`
  - `apps/api/src/services/__tests__/softAuthenticator.ts`
  - `apps/api/src/controllers/__tests__/TwoFactor.test.ts`
  - `apps/web/src/lib/twoFactor.ts`
  - `apps/web/src/components/TwoFactorStep.tsx`
  - `apps/web/src/components/TwoFactorSettings.tsx`
  - `apps/web/src/pages/auth/login.tsx`
  - `apps/web/src/pages/auth/two-factor.tsx`
  - `apps/web/src/pages/account/index.tsx`
  - `apps/web/src/pages/_app.tsx`
  - `apps/wiki/content/docs/guides/two-factor-authentication.mdx`
  - `apps/wiki/content/docs/guides/meta.json`
  - `apps/wiki/content/docs/self-hosting/environment-variables.mdx`
  - `apps/api/.env.example`
  - `.env.self-host.example`
- **What:**
  - **Factors:** a user can turn on an authenticator app (TOTP, RFC 6238: SHA-1, six digits, 30 seconds, one step
    of drift either way; `Totp.ts`, no dependency) and add passkeys (WebAuthn through `@simplewebauthn/server` and
    `/browser`; the relying party is `DASHBOARD_URI`'s host, discoverable credentials, `none` attestation). The
    first factor comes with ten one-time recovery codes, shown once, stored as SHA-256 hashes salted with the user
    (`fork_recovery_codes`); they go with the last factor. The app's secret is stored encrypted (AES-256-GCM, key
    derived with HKDF from `TWO_FACTOR_ENCRYPTION_KEY`, or else `JWT_SECRET`; a secret under `JWT_SECRET`'s key moves
    to the dedicated one when used) in `users.fork_totp_secret`, with `fork_totp_enabled_at`; passkeys in
    `fork_passkeys` (credential id, public key, a 64-bit signature counter, transports, device type, backup state).
    Apps and passkey prompts name the instance after the dashboard's host, `Plunk (host)`.
  - **Sign-in:** with a factor on, `POST /auth/login` answers `{ success: 'twoFactor', data: { challenge, methods } }`
    and sets no cookie, and the OAuth callbacks redirect to the dashboard's `/auth/two-factor`. The second step,
    `POST /two-factor/code` (an app or recovery code) or `POST /two-factor/passkey/options` + `POST /two-factor/passkey`,
    sets the session. The one-time sign-in token lives 10 minutes in Redis and takes five attempts; ten attempts within
    15 minutes hold the user off across sign-ins. Attempts are counted (one Lua `INCR` and `EXPIRE`, any Redis)
    before they are checked, so concurrent ones can't get past the limits. An app code's time step works once. A
    passkey also signs in on its own (`passkey/options` without a token), which requires user verification; its
    options keep no state (the token is the challenge and its expiry, HMAC-signed), and a used challenge is recorded
    once it signs in.
  - **Settings:** `GET /two-factor`, `POST /two-factor/totp/setup` and `POST|DELETE /two-factor/totp`,
    `POST /two-factor/recovery-codes`, `POST /two-factor/passkeys/options`, `POST /two-factor/passkeys`,
    `DELETE /two-factor/passkeys/:id`, for the signed-in user. Changes need a session from the last 15 minutes (the
    session token's `iat`), so a leaked older session can't add a passkey or turn the factor off, and a request whose
    `Origin` isn't the dashboard is refused (some have no body, so no CORS preflight would stop a cross-site form).
    Each change, and each recovery code used, sends the user a security notice through the platform emails. The
    account page has the card; the login page has the second step and **Sign in with a passkey**; the OAuth step's
    page takes the token out of the URL once read.
- **Why:** dashboard accounts can send email for every project they belong to; a password alone is a single point of
  failure.
- **Remove when:** upstream has two-factor authentication.

### D40 — Corrected API docs

- **Since:** 2026-10-15
- **Kind:** docs
- **Upstream:** not proposed (candidates)
- **Files:**
  - `apps/wiki/content/docs/api-reference/overview.mdx`
  - `apps/wiki/content/docs/api-reference/errors.mdx`
  - `apps/wiki/content/docs/concepts/contacts.mdx`
  - `apps/wiki/content/docs/concepts/topics.mdx`
  - `apps/wiki/content/docs/guides/webhooks.mdx`
  - `apps/wiki/content/docs/self-hosting/environment-variables.mdx`
  - `apps/api/.env.example`
  - `.env.self-host.example`
- **What:** pages that said what the API does not do now say what it does.
  - `/api-reference/overview`:
    - `POST /v1/track` takes the public key only (`requirePublicKey`), not "`pk_*` or `sk_*`".
    - Rate limits are the per-project token buckets that `RATE_LIMIT_ENABLED` switches on, not "1000
      requests/minute".
    - Templates and campaigns page with `page` and `pageSize`, not "mostly cursor-based".
    - The endpoint tables list the fork's routes: the report-back, contact topics, topics, layouts and scoped keys.
  - `/concepts/contacts`: `POST /contacts` creates a contact subscribed when `subscribed` is left out
    (`ContactService.upsert`), not unsubscribed. The transactional-send link points at `sendEmail`.
  - `/api-reference/errors`: lists `IDEMPOTENCY_KEY_REUSED` (409).
  - `/guides/webhooks`: `contact.(un)subscribed` reasons include `snooze` and `snooze_expired`, and topic changes
    carry `topic`.
  - `PLUNK_API_KEY`: the env reference and both example files call it a secret key, since platform mail is sent
    through `/v1/send`. The env reference had called it a `pk_` key.
  - `/concepts/topics`: its API table no longer breaks around a paragraph.
- **Why:** an integration written from these pages failed (a secret key on `/v1/track`) or behaved unexpectedly (a
  contact created subscribed).
- **Remove when:** upstream's pages say the same.

### D41 — Node 22

- **Since:** 2026-10-22
- **Kind:** fix
- **Upstream:** not proposed
- **Files:**
  - `Dockerfile`
  - `.github/workflows/ci.yml`
  - `.github/workflows/fork-checks.yml`
  - `.github/workflows/fork-release.yml`
- **What:** the image is built and run on `node:22.23.4-slim` and `node:22.23.4-alpine` instead of `node:20-slim` and
  `node:20-alpine`, and CI, the fork checks and the release workflow set up Node 22 instead of 20. The `engines`
  floor (`>=20`) is unchanged.
- **Why:** the Node.js security release of 2026-10-21 fixes a remote code execution in Brotli decompression
  (CVE-2026-111497) in Node 22.23.4 and ships no fix for Node 20, which is end of life.
- **Remove when:** upstream builds its image on a Node release that has the fix.

## Repository settings

Settings that live in GitHub rather than in files:

- `next` is protected for everyone, administrators included: changes land through pull requests, and force pushes and
  deletion are blocked.
- Pull requests to `next` merge only when the `Divergence audit`, `Strict type checks & API reference`,
  `Lint & Type Check` and `Test Suite` checks pass. The `Fork release` workflow requires the same four on a candidate's
  commit (`Require green CI`); keep both lists in step.
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

| Fork tag         | Upstream base                                                                                                      | Image                                                                                            | Divergences      | Notes                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------- |
| `v0.15.0-fork.1` | `17e840b` (`v0.15.0` plus "feat: Add automatic conversion to text/plain")                                          | `ghcr.io/fmd-labs/plunk@sha256:aa07bb659094d2e06cd6b73d81b7b17affeb7391ba96f8567757ba20d31d4341` | D01–D26          | First release, of `a778f16`; candidate `sha-a778f16-run.36010486336`.                                    |
| `v0.15.0-fork.2` | `17e840b` (`v0.15.0` plus "feat: Add automatic conversion to text/plain")                                          | `ghcr.io/fmd-labs/plunk@sha256:4b68c1b06eb8062d5b660c842091185350516860b0439669fc223b4d13cbbc95` | D01–D26          | Review fixes (#29), of `ddc4e72`; candidate `sha-ddc4e72-run.36134935251`.                               |
| `v0.15.0-fork.3` | `8d5a8d6` (`v0.15.0` plus upstream `next` up to "Merge pull request #517")                                         | `ghcr.io/fmd-labs/plunk@sha256:27dae6a0bb0ffaed2bc81a304cd167e1c3ab9b0978ead54d5ba98fef11ad611a` | D01–D25, D27     | Upstream sync (#31, #32): D26 dropped, D27 added; of `86016d2`; candidate `sha-86016d2-run.37681502475`. |
| `v0.16.0-fork.1` | `76b4efb` (`v0.16.0` plus upstream `next` up to "fix: Add lazy loading of email bodies to speed up activity feed") | `ghcr.io/fmd-labs/plunk@sha256:28acda4e8f1dd8638aaaaaa082a42c770208754810d5462fbdca7a5968700114` | D01–D25, D27–D39 | Upstream sync (#33), D28–D39 (#35–#46); of `5f7763b`; candidate `sha-5f7763b-run.38746074701`.           |
| `v0.16.0-fork.2` | `76b4efb` (`v0.16.0` plus upstream `next` up to "fix: Add lazy loading of email bodies to speed up activity feed") | `ghcr.io/fmd-labs/plunk@sha256:8262aebc6493fbead0f7ae87c4658a168593282a53bf6f275aba69f4a357e465` | D01–D25, D27–D40 | Corrected API docs, D40 (#49); of `5b23e85`; candidate `sha-5b23e85-run.38788584551`.                    |

Fork releases are tagged `v<upstream version>-fork.<n>`, for example `v0.15.0-fork.1`. `<upstream version>` is the
upstream release named in **Base**, the latest one the merge base contains (fork clones keep upstream's later tags
out, so to check it, fetch that tag first: `git fetch upstream tag <version>`, then
`git describe --tags --abbrev=0 <merge base>`), and `<n>` counts
fork releases on that upstream version. A fork tag is a SemVer pre-release, so it sorts below the upstream release of
the same number; that is intended, as no floating tags (`latest`, `0.15`) are published. The image tag drops the `v`:
`ghcr.io/fmd-labs/plunk:0.15.0-fork.1`.

To release:

1. Set the `plunk` image in the bundled `docker-compose.yml` to the version (`ghcr.io/fmd-labs/plunk:0.15.0-fork.1`)
   in the pull request that prepares the release, and wait for CI on `next` after it is merged: a candidate is built
   only from a commit whose required checks passed.
2. Run the `Fork release` workflow on `next` with the version:
   `gh workflow run fork-release.yml --ref next -f version=0.15.0-fork.1`. The run is named `Candidate 0.15.0-fork.1`.
   It builds the amd64 and arm64 images once, publishes them only under a candidate tag unique to the run,
   `sha-<first 7 characters of the commit>-run.<run id>` (with the version in the image labels), records the digest
   it published with the run (artifact `candidate-digest`), and smoke-tests exactly that image on both architectures:
   migrations on a fresh database, `/health`, and a worker that starts once and stays up. The run summary lists the
   candidate by tag and digest, and the full commit. A candidate tag is written once: re-running a run keeps the
   candidate it published and smoke-tests that image again, and building again takes a new run.
3. The first candidate run creates the `plunk` package in this organization's container registry as private: make it
   public in the package settings (**Change visibility**) before promoting.
4. Verify the candidate image, by digest, end to end.
5. Once the candidate run has succeeded, tag its commit, naming the commit explicitly and the verified digest in the
   message, and push only that tag:
   `git tag -a v0.15.0-fork.1 <commit> -m "0.15.0-fork.1" -m "Image: ghcr.io/fmd-labs/plunk@sha256:<digest>"`, then
   `git push origin v0.15.0-fork.1` (never `git push --tags`). A pushed tag cannot be moved, so check it first:
   `git tag -l --format='%(contents)' v0.15.0-fork.1` and
   `docker buildx imagetools inspect ghcr.io/fmd-labs/plunk@sha256:<digest>` (a local tag can still be deleted with
   `git tag -d`). The tag run promotes exactly that digest, provided a
   successful `Candidate 0.15.0-fork.1` run of that commit on `next` published it (as that run recorded, and as its
   candidate tag still names), without rebuilding it. It checks that the image can be pulled anonymously before
   creating anything, never replaces an existing release image, and treats a release tag that already points to the
   digest as done, so a failed run can be re-run.
6. Record the release in the table above (tag, upstream base, image digest, divergences) in a follow-up pull request.

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

Migrations the fork applied stay in the database. An upstream image's `prisma migrate deploy` applies only the
migrations it lacks and ignores the fork's (checked with Prisma 6.19), and upstream's code never reads the tables and
columns they add, since fork migrations only add (see **Policy**). An upstream migration dated before a fork migration
still applies after it, and a fork image deployed again later finds its own migrations already applied, as long as it
is not older than the upstream image it replaces. Rows written while the upstream image runs carry the fork columns'
defaults or `NULL`, and have no rows in the fork's tables.

A fork migration that failed blocks every later `migrate deploy`, upstream's included (`P3009`), so an upstream image
restarts in a loop as well. Prisma runs a migration in one transaction on Postgres, so the failed one left nothing
behind: mark it rolled back first, from either image's migrations folder,
`npx prisma migrate resolve --rolled-back <migration name> --schema packages/db/prisma/schema.prisma`.

## Rollback notes

- **D04, D22:** an upstream image ignores the `acceptedBySes` checkpoint on queued jobs, so an email whose SES acceptance
  was checkpointed but not yet recorded stays `SENDING`, and its campaign never finishes. Such jobs complete once the
  database is reachable (D22 waits for it without spending attempts); before rolling back, check that no email is left
  `SENDING`. To repair one afterwards, copy `messageId` and `sentAt` from its job's `acceptedBySes` onto the row and mark
  it `SENT` while the job still exists: a completed job is removed once 1,000 later ones completed, and the checkpoint
  with it. Emails the upstream image sends after an earlier failed attempt keep that attempt's `error` text, because
  upstream's `SENT` write does not clear it.
- **D07:** an upstream image's campaign cancellation does not count emails whose error starts with
  `SES outcome unknown` as possibly sent (D04's known issue returns for them).
- **D11:** an upstream image clears the body of every email older than 90 days within a day, those still `PENDING` or
  `SENDING` included. After running with `EMAIL_BODY_RETENTION_DAYS=0` or above `90`, the bodies the fork kept are
  lost; back up the `emails` table first if they matter.
- **D14, D20, D24:** `GET /v1/emails/:id` and `POST /v1/send/batch` answer `404`, and `email.failed` is no longer
  tracked; callers and workflows that use them stop working.
- **D17, D25:** an upstream image never sends an email left `PENDING` without a job (a keyed send whose job could not
  be queued, a job lost from Redis), and has no sweep to settle it; a retry of `/v1/send` with its key is refused with
  `409` instead of finishing the request.
- **D18:** an upstream image renders every email and strips only `X-Plunk-Recipient-Override`, so emails queued with
  templating off would go out rendered and with an `X-Plunk-Templating` header. It also ignores `templating: false`
  on new requests, without an error. Let the queue drain before rolling back.
- **D19:** an upstream image sends the internal `X-Plunk-Priority` header of emails queued with a priority to their
  recipients. Let the queue drain before rolling back.
- **D28:** every queued email carries `X-Plunk-Templating: off`, which an upstream image ignores and sends, rendering
  the stored result a second time (see D18). Let the queue drain before rolling back.
- **D29:** an upstream image ignores `projects.fork_escape_variables` and sends variables unescaped.
- **D32:** an upstream image ignores topics: campaigns reach every subscribed contact of their audience again,
  transactional campaigns come back, and new transactional contacts start unsubscribed. Contacts that transactional
  sends created subscribed under the fork stay subscribed, so they receive every marketing campaign of their audience.
  The topic tables and columns stay, and a fork image deployed again uses them as they were.
- **D33:** an upstream image ignores `projects.fork_unsubscribe_url_template`: links, footers and `List-Unsubscribe`
  point at Plunk's own pages again, which come back on and change `subscribed` for the whole contact, and
  `POST /v1/emails/:id/unsubscribed` answers `404`. Topic unsubscribes from Plunk's pages become full unsubscribes.
- **D34:** an upstream image ignores layouts: queued emails already composed in a layout go out without its CSS
  inlined, with Plunk's footer and with the internal `X-Plunk-Layout` header, and new emails go out without a layout.
  The editor shows a body with a button as custom HTML. Let the queue drain before rolling back.
- **D35:** an upstream image sends test emails as raw bodies again, without variables, layout or footer.
- **D36:** an upstream image ignores `campaigns.fork_sends_per_hour`: paced campaigns send their remaining batches in
  full and at once (a batch already queued with a delay still waits for it), and campaign emails go back to
  priority 10. Batches already queued keep their send token in data and id, which upstream ignores.
- **D37:** an upstream image does not know scoped keys: their requests answer `401`, and the project's own secret key
  is the only one. The `fork_api_keys` table and the attribution columns stay unread.
- **D38:** an upstream image ignores `projects.fork_avatar_url` and shows the projects' initials again.
- **D39:** an upstream image ignores the second factors: users sign in with their password or provider alone, and
  passkeys can't sign in. The `fork_*` columns and tables stay, and a fork image deployed again uses them as they were.
