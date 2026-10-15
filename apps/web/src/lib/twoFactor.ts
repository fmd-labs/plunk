import type {TwoFactorSchemas} from '@plunk/shared';
import {browserSupportsWebAuthn, startAuthentication, startRegistration} from '@simplewebauthn/browser';
import {useSyncExternalStore} from 'react';
import {network} from './network';

/** Two-factor authentication in the dashboard (fork D39). */

/** A sign-in waiting for its second step, as `POST /auth/login` (or the OAuth redirect) hands it over. */
export interface TwoFactorSignIn {
  challenge: string;
  methods: {totp: boolean; passkey: boolean};
}

export interface Passkey {
  id: string;
  name: string;
  deviceType: string;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

/** `GET /two-factor`: the signed-in user's factors. */
export interface TwoFactorStatus {
  totpEnabledAt: string | null;
  passkeys: Passkey[];
  recoveryCodesLeft: number;
  /** Whether the session is recent enough to change them. */
  recentSignIn: boolean;
}

type AuthenticationOptions = Parameters<typeof startAuthentication>[0]['optionsJSON'];
type RegistrationOptions = Parameters<typeof startRegistration>[0]['optionsJSON'];

/** Whether this browser can use passkeys at all. */
export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && browserSupportsWebAuthn();
}

const noSubscription = () => () => undefined;

/** `passkeysSupported` for rendering: false on the server and in the first client render, so hydration matches. */
export function usePasskeysSupported(): boolean {
  return useSyncExternalStore(noSubscription, passkeysSupported, () => false);
}

/**
 * Signs in with a passkey: as the second step of the sign-in `challenge` names, or, without one, on its own. Resolves
 * once the session cookie is set.
 */
export async function signInWithPasskey(challenge?: string): Promise<void> {
  const started = await network.fetch<
    {challenge: string; options: AuthenticationOptions},
    typeof TwoFactorSchemas.passkeyOptions
  >('POST', '/two-factor/passkey/options', challenge ? {challenge} : {});
  const response = await startAuthentication({optionsJSON: started.options});
  await network.fetch<unknown, typeof TwoFactorSchemas.passkey>('POST', '/two-factor/passkey', {
    challenge: started.challenge,
    response: response as unknown as (typeof TwoFactorSchemas.passkey)['_input']['response'],
  });
}

/** Adds a passkey on this device; the recovery codes when it is the user's first factor. */
export async function addPasskey(name: string): Promise<{recoveryCodes: string[] | null}> {
  const options = await network.fetch<RegistrationOptions>('POST', '/two-factor/passkeys/options');
  const response = await startRegistration({optionsJSON: options});
  return network.fetch<{recoveryCodes: string[] | null}, typeof TwoFactorSchemas.registerPasskey>(
    'POST',
    '/two-factor/passkeys',
    {name, response: response as unknown as (typeof TwoFactorSchemas.registerPasskey)['_input']['response']},
  );
}

/** A WebAuthn ceremony the user cancelled or let time out, which needs no error. */
export function isPasskeyCancel(error: unknown): boolean {
  return error instanceof Error && (error.name === 'NotAllowedError' || error.name === 'AbortError');
}
