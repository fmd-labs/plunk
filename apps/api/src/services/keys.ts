export const Keys = {
  User: {
    id(id: string): string {
      return `account:id:${id}`;
    },
    email(email: string): string {
      return `account:${email}`;
    },
    emailVerificationToken(token: string): string {
      return `auth:email_verification:${token}`;
    },
    passwordResetToken(token: string): string {
      return `auth:password_reset:${token}`;
    },
    emailVerificationRateLimit(userId: string): string {
      return `auth:email_verification_rate:${userId}`;
    },
    passwordResetRateLimit(email: string): string {
      return `auth:password_reset_rate:${email}`;
    },
    passwordChangeRateLimit(userId: string): string {
      return `auth:password_change_rate:${userId}`;
    },
  },
  RateLimit: {
    /** Per-project token bucket for an API endpoint group. See middleware/rateLimit.ts. */
    bucket(name: string, projectId: string): string {
      return `ratelimit:${name}:${projectId}`;
    },
  },
  Domain: {
    id(id: string): string {
      return `domain:id:${id}`;
    },
    project(projectId: string): string {
      return `domain:project:${projectId}`;
    },
    verifiedEmail(domainId: string): string {
      return `domain:verified_email:${domainId}`;
    },
    unverifiedEmail(domainId: string, year: number, month: string): string {
      return `domain:unverified_email:${domainId}:${year}-${month}`;
    },
  },
  Billing: {
    usage(projectId: string, sourceType: string, year: number, month: string): string {
      return `billing:usage:${projectId}:${sourceType}:${year}-${month}`;
    },
    warningEmail(projectId: string, sourceType: string, year: number, month: string): string {
      return `billing:warning_email:${projectId}:${sourceType}:${year}-${month}`;
    },
    limitEmail(projectId: string, sourceType: string, year: number, month: string): string {
      return `billing:limit_email:${projectId}:${sourceType}:${year}-${month}`;
    },
  },
  Security: {
    rates(projectId: string): string {
      return `security:${projectId}:rates`;
    },
  },
  Activity: {
    stats(projectId: string, startTime: number | string, endTime: number | string): string {
      return `activity:stats:${projectId}:${startTime}:${endTime}`;
    },
    recentCount(projectId: string, minutes: number): string {
      return `activity:recent-count:${projectId}:${minutes}`;
    },
  },
  Analytics: {
    query(projectId: string, kind: string, params: string): string {
      return `analytics:${kind}:${projectId}:${params}`;
    },
  },
  Workflow: {
    enabled(projectId: string): string {
      return `workflows:enabled:${projectId}`;
    },
  },
  Membership: {
    access(userId: string, projectId: string): string {
      return `membership:access:${userId}:${projectId}`;
    },
    admin(userId: string, projectId: string): string {
      return `membership:admin:${userId}:${projectId}`;
    },
    full(userId: string, projectId: string): string {
      return `membership:full:${userId}:${projectId}`;
    },
    owner(projectId: string): string {
      return `membership:owner:${projectId}`;
    },
  },
  Campaign: {
    /**
     * Emails sent so far in an in-flight campaign.
     *
     * Held in Redis rather than incremented on the campaign row: the send path runs
     * once per recipient at a concurrency derived from the SES quota, and every one
     * of those writes would contend for the same row and leave a dead tuple behind.
     * `Campaign.sentCount` is written once, when the send finalizes.
     */
    sentProgress(campaignId: string): string {
      return `campaign:sent_progress:${campaignId}`;
    },

    /**
     * Set of campaigns whose materialized counters are behind their email rows.
     *
     * One set for the whole install rather than a key per campaign: the sweep needs to
     * find the campaigns that changed without scanning the keyspace, and SADD of an id
     * that is already a member is free. Membership is the only state -- what changed and
     * how much is re-derived by counting the emails, so a duplicate add costs nothing and
     * a lost one is corrected by the next event on that campaign.
     */
    statsDirty(): string {
      return 'campaign:stats_dirty';
    },
  },
  Email: {
    /**
     * Where the stalled-email sweep stopped in one of its passes (`direct`: emails of no campaign;
     * `campaign`): the last email it looked at, in the order it pages through them. Kept between
     * runs, so that a long queue of emails waiting their turn does not make every run look at the
     * same ones; removed once a run reaches the end.
     */
    stallSweepCursor(pass: 'direct' | 'campaign'): string {
      return `email:stall_sweep_cursor:${pass}`;
    },
  },
  Project: {
    id(id: string): string {
      return `project:id:${id}`;
    },
    secret(key: string): string {
      return `project:secret:${key}`;
    },
    public(key: string): string {
      return `project:public:${key}`;
    },
  },
  // Fork (D39): two-factor authentication.
  TwoFactor: {
    /** A sign-in waiting for its second factor (or a passkey sign-in), by its one-time token. */
    signIn(token: string): string {
      return `two_factor:sign_in:${token}`;
    },
    /** A user's second-factor attempts, across sign-ins, in the current window; counted before each is checked. */
    attempts(userId: string): string {
      return `two_factor:attempts:${userId}`;
    },
    /** One sign-in's second-factor attempts, counted before each is checked. */
    signInAttempts(token: string): string {
      return `two_factor:sign_in_attempts:${token}`;
    },
    /** A passkey sign-in's challenge that was used, so its signed token signs in once. */
    passkeyChallengeUsed(challenge: string): string {
      return `two_factor:passkey_challenge_used:${challenge}`;
    },
    /** The authenticator-app secret being set up, until its first code confirms it. */
    totpSetup(userId: string): string {
      return `two_factor:totp_setup:${userId}`;
    },
    /** A time step whose code was used, so the same code works once. */
    totpStepUsed(userId: string, step: number): string {
      return `two_factor:totp_used:${userId}:${step}`;
    },
    /** The challenge of a passkey being added. */
    passkeyRegistration(userId: string): string {
      return `two_factor:passkey_registration:${userId}`;
    },
  },
} as const;
