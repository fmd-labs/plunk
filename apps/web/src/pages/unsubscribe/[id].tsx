import {ContactSchemas} from '@plunk/shared';
import type {SnoozeDuration} from '@plunk/types';
import {Button, IconSpinner} from '@plunk/ui';
import {Check, Clock} from 'lucide-react';
import {useRouter} from 'next/router';
import React, {useState} from 'react';

import {
  CardFooterNote,
  CardIntro,
  ErrorCard,
  FooterAction,
  InlineError,
  LoadingCard,
  RecipientShell,
  ResultState,
  RichText,
  SnoozePicker,
  useRecipient,
} from '../../components/list-management/ListManagement';
import {network} from '../../lib/network';
import {type ContactInfo, formatSnoozeDate, isSnoozed} from '../../lib/snooze';
import {getSourceEmailId, sourceEmailQuery, withSourceEmail} from '../../lib/sourceEmail';

export default function Unsubscribe() {
  const router = useRouter();
  const {id} = router.query;
  const {state, updateContact} = useRecipient(id, getSourceEmailId(router.query));

  const [unsubscribing, setUnsubscribing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (state.status === 'loading') {
    return (
      <RecipientShell page="unsubscribe" loading>
        <LoadingCard />
      </RecipientShell>
    );
  }

  if (state.status === 'error') {
    return (
      <RecipientShell page="unsubscribe" translator={state.translator}>
        <ErrorCard translator={state.translator} message={state.message} />
      </RecipientShell>
    );
  }

  const {contact, translator} = state;
  const contactId = id as string;
  const goTo = (path: string) => void router.push(withSourceEmail(path, router.query));

  const handleUnsubscribe = async () => {
    try {
      setUnsubscribing(true);
      setActionError(null);
      const data = await network.fetch<ContactInfo>(
        'POST',
        `/contacts/public/${contactId}/unsubscribe${sourceEmailQuery(router.query)}`,
      );
      updateContact(data);
    } catch {
      // Translated copy rather than the server's English message; see useRecipient.
      setActionError(translator.t('pages.common.actionFailed'));
    } finally {
      setUnsubscribing(false);
    }
  };

  // Fork (D33): from an email of a campaign with a topic, the page offers to leave that topic only.
  const topic = contact.topic;

  const handleTopic = async (subscribed: boolean) => {
    if (!topic) return;
    try {
      setUnsubscribing(true);
      setActionError(null);
      const data = await network.fetch<ContactInfo, typeof ContactSchemas.publicSubscription>(
        'POST',
        `/contacts/public/${contactId}/${subscribed ? 'subscribe' : 'unsubscribe'}${sourceEmailQuery(router.query)}`,
        {topic: topic.slug},
      );
      updateContact(data);
    } catch {
      // Translated copy rather than the server's English message; see useRecipient.
      setActionError(translator.t('pages.common.actionFailed'));
    } finally {
      setUnsubscribing(false);
    }
  };

  const handleSnooze = async (duration: SnoozeDuration) => {
    try {
      setActionError(null);
      const data = await network.fetch<ContactInfo, typeof ContactSchemas.snooze>(
        'POST',
        `/contacts/public/${contactId}/snooze${sourceEmailQuery(router.query)}`,
        {duration},
      );
      updateContact(data);
    } catch {
      // Translated copy rather than the server's English message; see useRecipient.
      setActionError(translator.t('pages.common.actionFailed'));
    }
  };

  // Checked before the unsubscribed state: a snoozed contact is `subscribed: false` too, and
  // telling someone who asked for a break that they are gone would be wrong.
  if (isSnoozed(contact)) {
    return (
      <RecipientShell page="unsubscribe" translator={translator}>
        <ResultState icon={Clock} title={translator.t('pages.snooze.successTitle')}>
          <RichText
            template={translator.t('pages.snooze.successDescription')}
            values={{projectName: contact.projectName, email: contact.email, date: formatSnoozeDate(contact.snoozedUntil, contact.language)}}
          />
        </ResultState>
        <CardFooterNote>
          <FooterAction onClick={() => goTo(`/subscribe/${contactId}`)}>{translator.t('pages.snooze.resume')}</FooterAction>
        </CardFooterNote>
      </RecipientShell>
    );
  }

  if (!contact.subscribed) {
    return (
      <RecipientShell page="unsubscribe" translator={translator}>
        <ResultState icon={Check} title={translator.t('pages.unsubscribe.successTitle')}>
          <RichText template={translator.t('pages.unsubscribe.successDescription')} values={{projectName: contact.projectName, email: contact.email}} />
        </ResultState>
        <CardFooterNote>
          {translator.t('pages.unsubscribe.changedMind')}{' '}
          <FooterAction onClick={() => goTo(`/subscribe/${contactId}`)}>
            {translator.t('pages.unsubscribe.subscribeAgain')}
          </FooterAction>
        </CardFooterNote>
      </RecipientShell>
    );
  }

  const values = {projectName: contact.projectName, email: contact.email, topicName: topic?.name ?? ''};

  if (topic && !topic.subscribed) {
    return (
      <RecipientShell page="unsubscribe" translator={translator}>
        <ResultState icon={Check} title={translator.t('pages.unsubscribe.topicSuccessTitle', {topicName: topic.name})}>
          <RichText template={translator.t('pages.unsubscribe.topicSuccessDescription')} values={values} />
        </ResultState>
        {actionError ? (
          <div className="px-6 pb-4 sm:px-8">
            <InlineError message={actionError} />
          </div>
        ) : null}
        <CardFooterNote>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <span>
              {translator.t('pages.unsubscribe.changedMind')}{' '}
              <FooterAction onClick={() => void handleTopic(true)}>
                {translator.t('pages.unsubscribe.subscribeAgain')}
              </FooterAction>
            </span>
            <FooterAction onClick={() => void handleUnsubscribe()}>
              {translator.t('pages.unsubscribe.unsubscribeAll')}
            </FooterAction>
          </div>
        </CardFooterNote>
      </RecipientShell>
    );
  }

  return (
    <RecipientShell page="unsubscribe" translator={translator}>
      <div className="flex flex-col gap-6 p-6 sm:p-8">
        {topic ? (
          <CardIntro title={translator.t('pages.unsubscribe.topicTitle', {topicName: topic.name})}>
            <RichText template={translator.t('pages.unsubscribe.topicDescription')} values={values} />
          </CardIntro>
        ) : (
          <CardIntro title={translator.t('pages.unsubscribe.title')}>
            <RichText template={translator.t('pages.unsubscribe.description')} values={values} />
          </CardIntro>
        )}

        <InlineError message={actionError} />

        <div className="flex flex-col gap-2">
          {/*
            Neutral, not red. Unsubscribing is what this recipient came to do, not a mistake to
            be warned off; painting it as danger is a dark pattern on the one page where the
            sender's reputation depends on the exit being easy.
          */}
          <Button
            size="lg"
            className="w-full"
            disabled={unsubscribing}
            aria-busy={unsubscribing || undefined}
            onClick={() => void (topic ? handleTopic(false) : handleUnsubscribe())}
          >
            {unsubscribing ? (
              <>
                <IconSpinner size="sm" />
                {translator.t('pages.unsubscribe.buttonLoading')}
              </>
            ) : (
              translator.t('pages.unsubscribe.button')
            )}
          </Button>

          <SnoozePicker translator={translator} onSnooze={handleSnooze} disabled={unsubscribing} />
        </div>
      </div>

      <CardFooterNote>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <FooterAction onClick={() => goTo(`/manage/${contactId}`)}>
            {translator.t('pages.unsubscribe.managePreferences')}
          </FooterAction>
          {topic ? (
            <FooterAction onClick={() => void handleUnsubscribe()}>
              {translator.t('pages.unsubscribe.unsubscribeAll')}
            </FooterAction>
          ) : null}
        </div>
      </CardFooterNote>
    </RecipientShell>
  );
}
