import type {EmailBodyCleanupJobData} from '@plunk/types';
import type {Job} from 'bullmq';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {EMAIL_BODY_RETENTION_DAYS} from '../../app/constants';
import {processCleanup} from '../email-body-cleanup-processor';

function cleanupJob() {
  return {updateProgress: vi.fn()} as unknown as Job<EmailBodyCleanupJobData>;
}

describe('email body cleanup', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let contactId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    contactId = (await factories.createContact({projectId})).id;
  });

  /** An email with a body, created `days` days ago. */
  async function emailFrom(days: number) {
    const email = await factories.createEmail(projectId, contactId, {body: '<p>Hello</p>'});
    return prisma.email.update({
      where: {id: email.id},
      data: {createdAt: new Date(Date.now() - days * 24 * 60 * 60 * 1000)},
    });
  }

  async function bodyOf(emailId: string) {
    return (await prisma.email.findUniqueOrThrow({where: {id: emailId}})).body;
  }

  it('keeps bodies for 90 days by default', async () => {
    const old = await emailFrom(91);
    const recent = await emailFrom(89);

    expect(EMAIL_BODY_RETENTION_DAYS).toBe(90);
    await expect(processCleanup(cleanupJob())).resolves.toEqual({cleared: 1});

    expect(await bodyOf(old.id)).toBe('');
    expect(await bodyOf(recent.id)).toBe('<p>Hello</p>');
  });

  it('clears the bodies older than the configured retention', async () => {
    const old = await emailFrom(31);
    const recent = await emailFrom(29);

    await expect(processCleanup(cleanupJob(), 30)).resolves.toEqual({cleared: 1});

    expect(await bodyOf(old.id)).toBe('');
    expect(await bodyOf(recent.id)).toBe('<p>Hello</p>');
  });

  it('keeps every body when the retention is 0', async () => {
    const old = await emailFrom(3650);

    await expect(processCleanup(cleanupJob(), 0)).resolves.toEqual({cleared: 0});

    expect(await bodyOf(old.id)).toBe('<p>Hello</p>');
  });
});
