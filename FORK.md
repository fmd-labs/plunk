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
- **Changed by D22:** a run that cannot record an accepted message waits for the database without spending the job's
  attempts.
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
- **Known issue (resolved by D22):** a run that loses its claim to another run of the same email completes its job.
  That takes BullMQ re-running a stalled job while its first run is still alive; if that first run then fails to record
  its outcome, the email is left `PENDING` or `SENDING` without a job.
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
    base64), folded so that no line passes 76 characters; an address list folds between addresses. RFC 5322 headers
    are ASCII, and clients show raw UTF-8 as mojibake. Other custom headers (addresses, URLs, message IDs) have a structure that encoded words would break, and
    are written as they are.
  - A display name with special characters is quoted, so a comma no longer splits the address list (`Lovelace, Ada`
    read as two addresses).
  - An attachment name that is not ASCII is an RFC 2231 `filename*` in UTF-8, in numbered continuations when it would
    make a line longer than 78 characters, and without an ASCII `filename`, which parsers that find both read
    instead. Content-Type adds the name in encoded words for clients that do not read RFC 2231.
  - Line breaks and other control characters in a header value become spaces, so a subject rendered from contact data
    or a name cannot add headers. The send schema also rejects line breaks in recipient names, the sender `name` and
    attachment content types.
  - SES's `Source` is the bare sender address, where upstream passes the unencoded `Name <address>`.
  - Headers of plain ASCII words are unchanged byte for byte (`SESService.rawEmail.test.ts`). ASCII headers change
    only where upstream's were ambiguous or malformed: a display name with special characters (`Acme Inc.`) is quoted,
    names are trimmed and an empty one leaves the bare address, control characters become spaces, a `\` or `"` in a
    file name is escaped, and angle brackets leave a Content-ID taken from a file name.
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
  read, no longer stops the cancellation, and the project's pending emails are failed even when clearing a queue fails.
  `getStats` counts prioritized jobs.
- **Known issue:** a send attempt that fails with its email left `SENDING` after the email's ownership was looked up,
  and queues its retry before the job is removed, loses that retry: the email stays `SENDING`.
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
  they were queued with, so a change applies to emails queued after a restart. The bundled `docker-compose.yml` passes
  both variables to the container.
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
  rendered HTML body before the daily cleanup clears it; `0` keeps every body, and the maximum is `36500`. Anything
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
  `ses:DeleteIdentity`, which deleting a domain uses to remove its SES identity. Both are called by the API.
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
  (`pages.common.sourceCode`). It must be an http(s) URL; anything else stops the API at startup. Unset shows no link,
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
- **Why:** upstream documents no way to check one email's delivery over the API; the status arrives as webhooks.
- **Remove when:** upstream adds an equivalent endpoint.

### D21 — Concurrent writes of a new contact both succeed

- **Since:** 2026-09-24
- **Kind:** fix
- **Upstream:** not proposed
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
    queues it (or the stalled-email sweep of D25 does, after 15 minutes); without one it is removed, since the caller's
    retry sends a new email, rather than left `PENDING` without a job.
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
  - `"templating": false` on `/v1/send` sends the subject and body exactly as given. The API skips its placeholder
    pass and marks the email with the internal header `X-Plunk-Templating: off`, on which the worker skips its Liquid
    pass. Combined with `template` it is refused (`422`).
  - Every `X-Plunk-*` header stored on an email is Plunk's own: the worker strips them all before sending (upstream
    strips only `X-Plunk-Recipient-Override`), `/v1/send` refuses them from callers (`422`), and the SMTP relay drops
    them. `/v1/send` header names must also be RFC 5322 field names (printable ASCII except the colon).
  - Placeholder keys are matched literally, where a `data` key such as `a(b` failed the request with a `500`, and
    values are inserted literally, where a `$&` or `$1` in a value acted as a replacement pattern.
- **Why:** content another system already rendered could be changed by Plunk's two templating passes (text that
  contains `{{` or `{%`), and a caller could set the internal recipient override and send the email elsewhere.
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
  - `apps/api/src/middleware/idempotency.ts`
  - `apps/api/src/middleware/rateLimit.ts`
  - `apps/wiki/openapi.json`
  - `apps/wiki/content/docs/api-reference/meta.json`
  - `apps/wiki/content/docs/api-reference/overview.mdx`
  - `apps/wiki/content/docs/guides/idempotency.mdx`
  - `apps/wiki/content/docs/concepts/transactional-emails.mdx`
  - `apps/wiki/content/docs/self-hosting/environment-variables.mdx`
- **What:** builds on D16, D17 and D19. `POST /v1/send/batch` (secret key) sends up to 100 emails, each a
  `/v1/send` body with one recipient (`SendBatchSchema`).
  - Every email is validated and prepared (template, sender domain) before any is sent; any refusal fails the request
    with `422` and a field error per email (`emails.<index>`), and nothing is sent.
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
  - The request counts once against a rate-limit budget of its own (`send-batch`, with the `/v1/send` numbers).
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
    even with `EMAIL_SEND_ATTEMPTS=1`.
  - A run that loses its claim to another run of the same email (BullMQ ran the job again after it stalled, while its
    first run was alive) looks at the email again after 2 minutes instead of completing the job, which is then still
    there to record the outcome should that first run fail to (D07's known issue).
  - A job that failed for good settles its email where its run did not: `settleFailedJob` runs on the worker's
    `failed` event once the job has finished, and settles an email its run left `PENDING` or `SENDING` (a write that
    failed with the send, or a job BullMQ failed without running it after it stalled too often). A checkpointed
    acceptance is run again, which records it; a `SENDING` email is failed as an unknown outcome, a `PENDING` one with
    the job's error. It is best-effort: it tries once, and a failure, such as the database still being unavailable, is
    only logged. It never rejects.
  - `processEmailJob` takes the worker's job token, which moving an active job requires.
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
    send (`X-Plunk-Test`), which is not recorded as an email. Older events, and events without a time, still get
    `404`.
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
    sent, which would follow the failure with `email.sent`.
  - A phishing block records the email's failure, disables the project, and only then reports the failure, so that
    none of the project's workflows run before it is disabled; a workflow an event of a disabled project triggers is
    cancelled at once.
  - It is not tracked for emails of a stopped campaign, for those `cancelAllProjectJobs` fails in bulk, or for
    workflow emails skipped for an unsubscribed contact. As an `email.*` name it is reserved like the others and can
    trigger workflows; the webhooks guide documents it, how workflow re-entry limits forwarding it, and why a workflow
    it triggers must not send email.
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
  - `apps/api/src/jobs/worker.ts`
  - `apps/api/src/app.ts`
  - `apps/api/src/services/QueueService.ts`
  - `packages/types/src/jobs/email.ts`
  - `apps/wiki/content/docs/guides/idempotency.mdx`
- **What:** builds on D19, D22 and D24. Every five minutes, a repeatable job on its own queue (`email-stall-sweep`)
  looks at the 500 emails left `PENDING` or `SENDING` the longest, untouched for 15 minutes or more
  (`sweepStalledEmails`), and settles each one that has no job to send it or record its outcome: a job lost from
  Redis, a job that failed for good while the email could not be written, an email whose job could not be queued. An
  email whose job still waits or runs is left to it. A job that failed for good settles its email as D22's
  `settleFailedJob` does. Otherwise a `PENDING` email is queued again with the priority it was sent with (a finished
  job under its ID is removed first); a `SENDING` email whose finished job holds an SES acceptance runs that job
  again, which records it; any other `SENDING` email is failed as an unknown outcome (`stalled_without_checkpoint`).
  A failure on one email does not stop the others.
- **Why:** an email left without a job was never sent, failed or recorded, and a campaign waiting on it never
  finished.
- **Remove when:** upstream settles emails left without a job.

### D26 — Test suite without MinIO

- **Since:** 2026-09-24
- **Kind:** ci
- **Upstream:** not proposed
- **Files:**
  - `.github/workflows/ci.yml`
- **What:** the `Test Suite` job no longer starts MinIO or creates its bucket, and its comments say so. No test reaches
  S3 (the job helpers mock file storage; the suite passes with `S3_ENDPOINT` pointing at a closed port), and the job's
  S3 settings stay, pointing at nothing.
- **Why:** MinIO's images no longer pull anonymously. Docker Hub's `minio/minio` stopped serving them in September 2026
  (upstream moved to quay.io in `7215b5f`), and `quay.io/minio/minio` and `quay.io/minio/mc` answer `401` since
  2026-09-24, so the job failed at `Start MinIO`. `docker-compose.yml` and `docker/docker-compose.dev.yml` still name
  the same MinIO server image.
- **Remove when:** upstream's CI stops pulling MinIO's images, or pulls them from a registry that serves them.

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
- **D18:** an upstream image renders every email and strips only `X-Plunk-Recipient-Override`, so emails queued with
  templating off would go out rendered and with an `X-Plunk-Templating` header. Let the queue drain before rolling
  back.
