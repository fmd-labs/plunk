import {Card, CardContent} from '@plunk/ui';
import {NextSeo} from 'next-seo';
import Image from 'next/image';
import {useRouter} from 'next/router';
import {useEffect, useSyncExternalStore} from 'react';
import {TwoFactorStep} from '../../components/TwoFactorStep';
import {useProjects} from '../../lib/hooks/useProject';
import {useUser} from '../../lib/hooks/useUser';
import type {TwoFactorSignIn} from '../../lib/twoFactor';

/** The sign-in the URL hands over, read once and kept, since the URL loses it right after. */
let handedOver: TwoFactorSignIn | null = null;
const noSubscription = () => () => undefined;

function readSignIn(): TwoFactorSignIn | null {
  if (!handedOver) {
    const query = new URLSearchParams(window.location.search);
    const challenge = query.get('challenge');
    if (challenge) {
      const methods = (query.get('methods') ?? '').split(',');
      handedOver = {challenge, methods: {totp: methods.includes('totp'), passkey: methods.includes('passkey')}};
    }
  }
  return handedOver;
}

/**
 * An OAuth sign-in's second step (fork D39): the API sends a user with two-factor authentication here with the
 * sign-in's token and the factors they have.
 */
export default function TwoFactor() {
  const router = useRouter();
  const {mutate: userMutate} = useUser();
  const {mutate: projectsMutate} = useProjects();

  const signIn = useSyncExternalStore(noSubscription, readSignIn, () => null);

  // The token is read; take it out of the URL, so it stays out of the history.
  useEffect(() => {
    if (signIn && window.location.search) {
      void router.replace('/auth/two-factor', undefined, {shallow: true});
    }
  }, [signIn, router]);

  if (!signIn) {
    return null;
  }

  return (
    <>
      <NextSeo title="Two-factor authentication" />
      <div
        className="min-h-screen flex items-center justify-center py-12"
        style={{
          backgroundColor: '#fafafa',
          backgroundImage: 'radial-gradient(#e5e7eb 1px, transparent 1px)',
          backgroundSize: '20px 20px',
        }}
      >
        <div className="flex flex-col gap-6 max-w-md w-full px-4">
          <div className="flex items-center justify-center gap-2.5">
            <div className="h-8 w-8 rounded-lg bg-white shadow-sm border border-neutral-200 flex items-center justify-center p-1">
              <Image src="/assets/logo.svg" alt="" aria-hidden width={24} height={24} />
            </div>
            <span className="text-lg font-bold tracking-tight text-neutral-900">Plunk</span>
          </div>
          <Card>
            <CardContent className="p-0">
              <TwoFactorStep
                signIn={signIn}
                onSignedIn={async () => {
                  await userMutate();
                  await projectsMutate();
                  await router.push('/');
                }}
                onCancel={() => void router.push('/auth/login')}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
