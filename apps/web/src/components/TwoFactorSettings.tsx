import {useState} from 'react';
import type {TwoFactorSchemas} from '@plunk/shared';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '@plunk/ui';
import {Copy, Download, KeyRound, ShieldCheck, Smartphone, Trash2} from 'lucide-react';
import QRCode from 'qrcode';
import {toast} from 'sonner';
import useSWR from 'swr';
import {formatRelativeTime} from '../lib/dateUtils';
import {network} from '../lib/network';
import {addPasskey, isPasskeyCancel, type Passkey, type TwoFactorStatus, usePasskeysSupported} from '../lib/twoFactor';

const errorText = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

/** Codes shown once: to copy or download, then gone. */
function RecoveryCodesDialog({codes, onClose}: {codes: string[] | null; onClose: () => void}) {
  const text = codes?.join('\n') ?? '';
  return (
    <Dialog open={codes !== null} onOpenChange={open => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save your recovery codes</DialogTitle>
          <DialogDescription>
            Each code signs you in once when you can’t use your authenticator app or passkey. They are shown only now;
            keep them somewhere safe.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-4 font-mono text-sm">
          {codes?.map(code => (
            <span key={code}>{code}</span>
          ))}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void navigator.clipboard.writeText(text).then(() => toast.success('Copied'));
              }}
            >
              <Copy className="h-4 w-4" />
              Copy
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                const link = document.createElement('a');
                link.href = URL.createObjectURL(new Blob([`${text}\n`], {type: 'text/plain'}));
                link.download = 'plunk-recovery-codes.txt';
                link.click();
                URL.revokeObjectURL(link.href);
              }}
            >
              <Download className="h-4 w-4" />
              Download
            </Button>
          </div>
          <Button type="button" onClick={onClose}>
            I saved them
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Setting up the authenticator app: scan, then confirm with a code. */
function TotpSetupDialog({
  setup,
  onClose,
  onEnabled,
}: {
  setup: {secret: string; qr: string} | null;
  onClose: () => void;
  onEnabled: (recoveryCodes: string[] | null) => void;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const enable = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const {recoveryCodes} = await network.fetch<{recoveryCodes: string[] | null}, typeof TwoFactorSchemas.enableTotp>(
        'POST',
        '/two-factor/totp',
        {code},
      );
      setCode('');
      onEnabled(recoveryCodes);
    } catch (error) {
      toast.error(errorText(error, 'Couldn’t turn on the authenticator app. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={setup !== null} onOpenChange={open => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={enable} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Set up an authenticator app</DialogTitle>
            <DialogDescription>
              Scan the code with an authenticator app (1Password, Google Authenticator, Authy…), then enter the code it
              shows.
            </DialogDescription>
          </DialogHeader>
          {setup && (
            <div className="flex flex-col items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element -- a data URL, generated here */}
              <img src={setup.qr} alt="QR code for the authenticator app" className="h-48 w-48" />
              <p className="text-center text-xs text-neutral-500">
                Can’t scan it? Enter this key:
                <br />
                <code className="break-all font-mono text-neutral-900">{setup.secret}</code>
              </p>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="totpCode">Code</Label>
            <Input
              id="totpCode"
              autoComplete="one-time-code"
              inputMode="numeric"
              placeholder="123456"
              maxLength={6}
              value={code}
              onChange={e => setCode(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !/^\d{6}$/.test(code)}>
              {busy ? 'Checking…' : 'Turn on'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A name for a new passkey, guessed from the device. */
function deviceName(): string {
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/iPhone/.test(agent)) return 'iPhone';
  if (/iPad/.test(agent)) return 'iPad';
  if (/Android/.test(agent)) return 'Android';
  if (/Mac OS X/.test(agent)) return 'Mac';
  if (/Windows/.test(agent)) return 'Windows';
  return 'Passkey';
}

/**
 * The account's two-factor authentication (fork D39): an authenticator app, passkeys and recovery codes. Changes
 * need a sign-in from the last 15 minutes.
 */
export function TwoFactorSettings() {
  const {data: status, mutate} = useSWR<TwoFactorStatus>('/two-factor', {revalidateOnFocus: true});
  const canUsePasskeys = usePasskeysSupported();
  const [totpSetup, setTotpSetup] = useState<{secret: string; qr: string} | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{type: 'totp'} | {type: 'codes'} | {type: 'passkey'; passkey: Passkey} | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  if (!status) {
    return null;
  }
  const locked = !status.recentSignIn;
  const factorCount = (status.totpEnabledAt ? 1 : 0) + status.passkeys.length;
  const anyFactor = factorCount > 0;

  /** Runs a change, then shows codes the API handed out and refreshes; a stale session shows the notice. */
  const run = async (change: () => Promise<{recoveryCodes?: string[] | null} | void>, failure: string) => {
    setBusy(true);
    try {
      const result = await change();
      if (result && result.recoveryCodes) {
        setCodes(result.recoveryCodes);
      }
    } catch (error) {
      if (!isPasskeyCancel(error)) {
        toast.error(errorText(error, failure));
      }
    } finally {
      setBusy(false);
      await mutate();
    }
  };

  const startTotp = () =>
    run(async () => {
      const {secret, uri} = await network.fetch<{secret: string; uri: string}>('POST', '/two-factor/totp/setup');
      setTotpSetup({secret, qr: await QRCode.toDataURL(uri, {margin: 1, width: 384})});
    }, 'Couldn’t start the setup. Try again.');

  const signInAgain = async () => {
    await network.fetch('GET', '/auth/logout').catch(() => undefined);
    window.location.href = '/auth/login';
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5" />
          Two-factor authentication
        </CardTitle>
        <CardDescription>
          A second step after your password or sign-in provider: a code from an authenticator app, or a passkey. A
          passkey can also sign you in on its own.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {locked && (
          <div className="flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 sm:flex-row sm:items-center sm:justify-between">
            <span>To change two-factor authentication, sign in again. It keeps a leaked session from changing it.</span>
            <Button type="button" size="sm" variant="outline" onClick={() => void signInAgain()}>
              Sign in again
            </Button>
          </div>
        )}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <Smartphone className="mt-0.5 h-5 w-5 text-neutral-500" />
            <div>
              <div className="flex items-center gap-2 font-medium text-neutral-900">
                Authenticator app
                {status.totpEnabledAt && <Badge variant="secondary">On</Badge>}
              </div>
              <p className="text-sm text-neutral-500">
                {status.totpEnabledAt
                  ? `Turned on ${formatRelativeTime(status.totpEnabledAt)}.`
                  : 'Six-digit codes from an app on your phone.'}
              </p>
            </div>
          </div>
          {status.totpEnabledAt ? (
            <Button type="button" variant="outline" disabled={locked || busy} onClick={() => setConfirm({type: 'totp'})}>
              Turn off
            </Button>
          ) : (
            <Button type="button" variant="outline" disabled={locked || busy} onClick={() => void startTotp()}>
              Set up
            </Button>
          )}
        </div>

        <div className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <KeyRound className="mt-0.5 h-5 w-5 text-neutral-500" />
              <div>
                <div className="font-medium text-neutral-900">Passkeys</div>
                <p className="text-sm text-neutral-500">
                  {canUsePasskeys
                    ? 'Your device’s fingerprint, face or screen lock, or a security key.'
                    : 'This browser can’t create passkeys.'}
                </p>
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={locked || busy || !canUsePasskeys}
              onClick={() => setNaming(deviceName())}
            >
              Add a passkey
            </Button>
          </div>
          {status.passkeys.length > 0 && (
            <ul className="divide-y divide-neutral-100 rounded-lg border border-neutral-200">
              {status.passkeys.map(passkey => (
                <li key={passkey.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium text-neutral-900">
                      <span className="truncate">{passkey.name}</span>
                      {passkey.deviceType === 'multiDevice' && <Badge variant="outline">Synced</Badge>}
                    </div>
                    <p className="text-xs text-neutral-500">
                      Added {formatRelativeTime(passkey.createdAt)}
                      {passkey.lastUsedAt ? `, last used ${formatRelativeTime(passkey.lastUsedAt)}` : ', never used'}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="destructiveGhost"
                    size="sm"
                    aria-label={`Remove ${passkey.name}`}
                    disabled={locked || busy}
                    onClick={() => setConfirm({type: 'passkey', passkey})}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {anyFactor && (
          <div className="flex flex-col gap-3 border-t border-neutral-100 pt-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="font-medium text-neutral-900">Recovery codes</div>
              <p className="text-sm text-neutral-500">
                {status.recoveryCodesLeft} of 10 left. Each signs you in once without your app or passkey.
              </p>
            </div>
            <Button type="button" variant="outline" disabled={locked || busy} onClick={() => setConfirm({type: 'codes'})}>
              Generate new codes
            </Button>
          </div>
        )}
      </CardContent>

      <TotpSetupDialog
        setup={totpSetup}
        onClose={() => setTotpSetup(null)}
        onEnabled={recoveryCodes => {
          setTotpSetup(null);
          toast.success('Authenticator app turned on');
          if (recoveryCodes) setCodes(recoveryCodes);
          void mutate();
        }}
      />

      <Dialog open={naming !== null} onOpenChange={open => !open && setNaming(null)}>
        <DialogContent className="sm:max-w-md">
          <form
            onSubmit={e => {
              e.preventDefault();
              const name = naming?.trim() || 'Passkey';
              setNaming(null);
              void run(async () => {
                const added = await addPasskey(name);
                toast.success('Passkey added');
                return added;
              }, 'Couldn’t add the passkey. Try again.');
            }}
            className="space-y-4"
          >
            <DialogHeader>
              <DialogTitle>Add a passkey</DialogTitle>
              <DialogDescription>Name it after the device or key, to tell your passkeys apart.</DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="passkeyName">Name</Label>
              <Input
                id="passkeyName"
                maxLength={100}
                value={naming ?? ''}
                onChange={e => setNaming(e.target.value)}
                autoFocus
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setNaming(null)}>
                Cancel
              </Button>
              <Button type="submit">Continue</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <RecoveryCodesDialog codes={codes} onClose={() => setCodes(null)} />

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={open => !open && setConfirm(null)}
        onConfirm={() => {
          const current = confirm;
          setConfirm(null);
          if (current?.type === 'totp') {
            void run(async () => {
              await network.fetch('DELETE', '/two-factor/totp');
              toast.success('Authenticator app turned off');
            }, 'Couldn’t turn off the authenticator app. Try again.');
          } else if (current?.type === 'passkey') {
            void run(async () => {
              await network.fetch('DELETE', `/two-factor/passkeys/${current.passkey.id}`);
              toast.success('Passkey removed');
            }, 'Couldn’t remove the passkey. Try again.');
          } else if (current?.type === 'codes') {
            void run(
              () => network.fetch<{recoveryCodes: string[]}>('POST', '/two-factor/recovery-codes'),
              'Couldn’t generate new codes. Try again.',
            );
          }
        }}
        title={
          confirm?.type === 'totp'
            ? 'Turn off the authenticator app?'
            : confirm?.type === 'passkey'
              ? `Remove ${confirm.passkey.name}?`
              : 'Generate new recovery codes?'
        }
        description={
          confirm?.type === 'codes'
            ? 'Your current codes stop working.'
            : factorCount === 1
              ? 'It is your last second factor: signing in needs only your password or provider again, and your recovery codes are removed.'
              : 'You can still sign in with your other second factors.'
        }
        confirmText={confirm?.type === 'codes' ? 'Generate' : confirm?.type === 'totp' ? 'Turn off' : 'Remove'}
        variant={confirm?.type === 'codes' ? 'default' : 'destructive'}
      />
    </Card>
  );
}
