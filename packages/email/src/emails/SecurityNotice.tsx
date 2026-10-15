import {Heading, Link, Section, Text} from '@react-email/components';
import * as React from 'react';
import {EmailLayout} from '../common/EmailLayout';
import {Footer} from '../common/Footer';
import {Header} from '../common/Header';

interface SecurityNoticeEmailProps {
  /** What changed, as a heading: "A passkey was added". */
  title: string;
  /** The change in a sentence or two. */
  message: string;
  /** Where the user reviews their sign-in settings. */
  accountUrl: string;
  landingUrl?: string;
}

/**
 * Tells a user that their sign-in settings changed (fork D39): a second factor added or removed, recovery codes
 * renewed or used. Sent so that a change they did not make doesn't go unnoticed.
 */
export function SecurityNoticeEmail({
  title = 'A passkey was added to your account',
  message = 'A passkey named “Laptop” can now sign in to your account.',
  accountUrl = 'https://next-app.useplunk.com/account',
  landingUrl = 'https://www.useplunk.com',
}: SecurityNoticeEmailProps) {
  return (
    <EmailLayout>
      <Header />

      <Section className="px-8 pb-10 pt-10">
        <Heading className="mb-2 mt-0 text-2xl font-semibold tracking-tight text-gray-900">{title}</Heading>

        <Text className="mb-8 mt-0 text-base leading-relaxed text-gray-600">{message}</Text>

        <Section className="mb-8 rounded-lg bg-amber-50 px-6 py-4" style={{border: '1px solid #fbbf24'}}>
          <Text className="mb-0 mt-0 text-sm leading-relaxed text-amber-900">
            If this wasn’t you, sign in, review your two-factor settings and change your password right away.
          </Text>
        </Section>

        <Section className="mb-8">
          <Link
            href={accountUrl}
            className="inline-block rounded-md bg-gray-900 px-6 py-3 text-sm font-medium text-white no-underline"
          >
            Review your account
          </Link>
        </Section>
      </Section>

      <Footer landingUrl={landingUrl} />
    </EmailLayout>
  );
}

export default SecurityNoticeEmail;
