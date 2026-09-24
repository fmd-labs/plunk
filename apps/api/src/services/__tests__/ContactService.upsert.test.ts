import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {prisma as runtimePrisma} from '../../database/prisma.js';
import {ContactService} from '../ContactService';

describe('ContactService.upsert', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('updates a contact that a concurrent request created after the lookup', async () => {
    const created = await factories.createContact({
      projectId,
      email: 'ada@example.com',
      data: {plan: 'pro'},
      subscribed: true,
    });
    // The lookup ran before the concurrent request created the contact.
    vi.spyOn(runtimePrisma.contact, 'findFirst').mockResolvedValueOnce(null);

    const contact = await ContactService.upsert(projectId, 'Ada@Example.com', {name: 'Ada'}, undefined, false);

    expect(contact).toMatchObject({id: created.id, subscribed: true, data: {plan: 'pro', name: 'Ada'}});
    expect(await prisma.contact.count({where: {projectId}})).toBe(1);
  });

  it('lets two requests that create the same contact at once both succeed', async () => {
    // Neither request finds the contact, so both create it.
    vi.spyOn(runtimePrisma.contact, 'findFirst').mockResolvedValueOnce(null).mockResolvedValueOnce(null);

    const [first, second] = await Promise.all([
      ContactService.upsert(projectId, 'ada@example.com', {name: 'Ada'}, undefined, false),
      ContactService.upsert(projectId, 'ada@example.com', {plan: 'pro'}, undefined, false),
    ]);

    expect(first.id).toBe(second.id);
    const [contact] = await prisma.contact.findMany({where: {projectId}});
    expect(contact).toMatchObject({id: first.id, subscribed: false, data: {name: 'Ada', plan: 'pro'}});
  });

  it('still refuses a contact it cannot create for another reason', async () => {
    vi.spyOn(runtimePrisma.contact, 'create').mockRejectedValueOnce(new Error('database unavailable'));

    await expect(ContactService.upsert(projectId, 'ada@example.com', {name: 'Ada'})).rejects.toThrow(
      'Failed to create contact: database unavailable',
    );
    expect(await prisma.contact.count({where: {projectId}})).toBe(0);
  });
});
