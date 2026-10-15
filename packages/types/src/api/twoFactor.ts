/**
 * Two-factor authentication (fork D39): what the API and the dashboard exchange.
 */

/** The second factors a user has on. */
export interface TwoFactorMethods {
  totp: boolean;
  passkey: boolean;
}

/** A sign-in waiting for its second step: its one-time token and the factors that can complete it. */
export interface TwoFactorSignIn {
  challenge: string;
  methods: TwoFactorMethods;
}

/** A passkey as `GET /two-factor` lists it. */
export interface TwoFactorPasskey {
  id: string;
  name: string;
  /** `singleDevice`, or `multiDevice` for a synced passkey. */
  deviceType: string;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

/** `GET /two-factor`: the signed-in user's factors. */
export interface TwoFactorStatus {
  totpEnabledAt: string | null;
  passkeys: TwoFactorPasskey[];
  recoveryCodesLeft: number;
  /** Whether the session is recent enough to change them. */
  recentSignIn: boolean;
}
