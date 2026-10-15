import {useState} from 'react';
import type {TwoFactorSchemas} from '@plunk/shared';
import {Button, IconSpinner, Input, Label} from '@plunk/ui';
import {KeyRound} from 'lucide-react';
import {network} from '../lib/network';
import {isPasskeyCancel, signInWithPasskey, type TwoFactorSignIn, usePasskeysSupported} from '../lib/twoFactor';

interface TwoFactorStepProps {
  signIn: TwoFactorSignIn;
  /** The session is set; go on into the dashboard. */
  onSignedIn: () => void | Promise<void>;
  /** Back to the first step. */
  onCancel: () => void;
}

/**
 * A sign-in's second step (fork D39): a code from the authenticator app, a passkey, or a recovery code. Shown after
 * the password, and after an OAuth provider.
 */
export function TwoFactorStep({signIn, onSignedIn, onCancel}: TwoFactorStepProps) {
  const canUsePasskey = usePasskeysSupported() && signIn.methods.passkey;
  // Without an authenticator app, a recovery code is the only thing to type.
  const [recovery, setRecovery] = useState(!signIn.methods.totp);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'code' | 'passkey' | null>(null);

  const submitCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('code');
    setError(null);
    try {
      await network.fetch<unknown, typeof TwoFactorSchemas.code>('POST', '/two-factor/code', {
        challenge: signIn.challenge,
        code,
      });
      await onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setCode('');
    } finally {
      setBusy(null);
    }
  };

  const usePasskey = async () => {
    setBusy('passkey');
    setError(null);
    try {
      await signInWithPasskey(signIn.challenge);
      await onSignedIn();
    } catch (err) {
      if (!isPasskeyCancel(err)) {
        setError(err instanceof Error ? err.message : 'The passkey did not work');
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <form onSubmit={submitCode} className="flex flex-col gap-6 p-8">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-bold tracking-tight">Two-factor authentication</h1>
        <p className="text-sm text-neutral-500">
          {!recovery
            ? `Enter the six-digit code from your authenticator app${canUsePasskey ? ', or use a passkey' : ''}.`
            : canUsePasskey && !signIn.methods.totp
              ? 'Use a passkey, or enter one of your recovery codes. Each code works once.'
              : 'Enter one of your recovery codes. Each one works once.'}
        </p>
      </div>

      {(signIn.methods.totp || recovery) && (
        <div className="grid gap-2">
          <Label htmlFor="twoFactorCode">{recovery ? 'Recovery code' : 'Code'}</Label>
          <Input
            id="twoFactorCode"
            autoFocus
            autoComplete="one-time-code"
            inputMode={recovery ? 'text' : 'numeric'}
            placeholder={recovery ? 'xxxxx-xxxxx' : '123456'}
            maxLength={recovery ? 32 : 6}
            value={code}
            onChange={e => setCode(e.target.value)}
          />
        </div>
      )}

      {error && <p className="text-sm text-red-500">{error}</p>}

      <div className="grid gap-2">
        {(signIn.methods.totp || recovery) && (
          <Button type="submit" className="w-full" disabled={busy !== null || code.trim().length < 6}>
            {busy === 'code' ? <IconSpinner size="sm" /> : null}
            Verify
          </Button>
        )}
        {canUsePasskey && (
          <Button type="button" variant="outline" className="w-full" disabled={busy !== null} onClick={usePasskey}>
            {busy === 'passkey' ? <IconSpinner size="sm" /> : <KeyRound className="h-4 w-4" />}
            Use a passkey
          </Button>
        )}
      </div>

      <div className="flex items-center justify-between text-sm">
        <button type="button" className="text-neutral-500 hover:text-neutral-900" onClick={onCancel}>
          Back to sign in
        </button>
        {signIn.methods.totp && (
          <button
            type="button"
            className="text-neutral-500 hover:text-neutral-900"
            onClick={() => {
              setRecovery(current => !current);
              setCode('');
              setError(null);
            }}
          >
            {recovery ? 'Use the authenticator app' : 'Use a recovery code'}
          </button>
        )}
      </div>
    </form>
  );
}
