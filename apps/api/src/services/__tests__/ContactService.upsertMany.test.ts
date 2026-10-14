import {ContactSchemas} from '@plunk/shared';
import {beforeEach, describe, expect, it} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {HttpException} from '../../exceptions';
import {ContactService} from '../ContactService';

/** Batch contact upsert and lookup ids (D30). */
describe('ContactService.upsertMany', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
  });

  const stored = (email: string) => prisma.contact.findUniqueOrThrow({where: {projectId_email: {projectId, email}}});
  const events = (contactId: string) =>
    prisma.event.findMany({where: {projectId, contactId}, select: {name: true}, orderBy: {createdAt: 'asc'}});

  it('creates new contacts, subscribed unless told otherwise, and answers in input order', async () => {
    await factories.createContact({projectId, email: 'b@example.com'});

    const results = await ContactService.upsertMany(projectId, [
      {email: 'C@Example.com', data: {plan: 'pro'}},
      {email: 'b@example.com'},
      {email: 'a@example.com', subscribed: false},
    ]);

    expect(results.map(({email, created, subscribed}) => ({email, created, subscribed}))).toEqual([
      {email: 'c@example.com', created: true, subscribed: true},
      {email: 'b@example.com', created: false, subscribed: true},
      {email: 'a@example.com', created: true, subscribed: false},
    ]);
    expect((await stored('c@example.com')).data).toEqual({plan: 'pro'});
    expect(results[0]!.id).toBe((await stored('c@example.com')).id);
  });

  it('merges data in place: null deletes, empty strings, reserved keys and non-persistent values are skipped', async () => {
    await factories.createContact({projectId, email: 'ada@example.com', data: {a: 1, b: 2, keep: 'x'}});

    await ContactService.upsertMany(projectId, [
      {
        email: 'ada@example.com',
        data: {
          b: null,
          c: {nested: true},
          keep: '',
          id: 'nope',
          manageUrl: 'nope',
          temp: {value: 1, persistent: false},
        },
      },
    ]);

    expect((await stored('ada@example.com')).data).toEqual({a: 1, keep: 'x', c: {nested: true}});
  });

  it('replaces a whole value, arrays and objects included', async () => {
    await factories.createContact({projectId, email: 'ada@example.com', data: {tags: ['a', 'b'], links: {x: 1, y: 2}}});

    await ContactService.upsertMany(projectId, [{email: 'ada@example.com', data: {tags: ['c'], links: {z: 3}}}]);

    expect((await stored('ada@example.com')).data).toEqual({tags: ['c'], links: {z: 3}});
  });

  it('stores data emptied by deletes as a JSON null, and merges into one', async () => {
    await factories.createContact({projectId, email: 'ada@example.com', data: {a: 1}});

    await ContactService.upsertMany(projectId, [{email: 'ada@example.com', data: {a: null}}]);
    expect((await stored('ada@example.com')).data).toBeNull();

    await ContactService.upsertMany(projectId, [{email: 'ada@example.com', data: {b: 2}}]);
    expect((await stored('ada@example.com')).data).toEqual({b: 2});
  });

  it('records a subscription change and ends a snooze only when subscribed is given', async () => {
    const until = new Date(Date.now() + 86_400_000);
    const contact = await factories.createContact({projectId, email: 'ada@example.com', subscribed: true});
    const snoozed = await factories.createContact({projectId, email: 'bob@example.com', subscribed: false});
    await prisma.contact.update({where: {id: snoozed.id}, data: {snoozedUntil: until}});

    await ContactService.upsertMany(projectId, [
      {email: 'ada@example.com', subscribed: false},
      {email: 'bob@example.com', data: {x: 1}},
    ]);

    expect(await stored('ada@example.com')).toMatchObject({subscribed: false, snoozedUntil: null});
    expect(await events(contact.id)).toEqual([{name: 'contact.unsubscribed'}]);
    expect((await stored('bob@example.com')).snoozedUntil).toEqual(until);
    expect(await events(snoozed.id)).toEqual([]);

    await ContactService.upsertMany(projectId, [{email: 'bob@example.com', subscribed: true}]);
    expect(await stored('bob@example.com')).toMatchObject({subscribed: true, snoozedUntil: null});
    expect(await events(snoozed.id)).toEqual([{name: 'contact.subscribed'}]);
  });

  it('records no subscription event for a new contact or an unchanged one', async () => {
    const existing = await factories.createContact({projectId, email: 'ada@example.com', subscribed: true});

    const [created] = await ContactService.upsertMany(projectId, [
      {email: 'new@example.com', subscribed: false},
      {email: 'ada@example.com', subscribed: true},
    ]);

    expect(await events(created!.id)).toEqual([]);
    expect(await events(existing.id)).toEqual([]);
  });

  it('refuses a batch that lists an address twice, and writes nothing', async () => {
    await expect(
      ContactService.upsertMany(projectId, [{email: 'ada@example.com'}, {email: 'ADA@example.com'}]),
    ).rejects.toBeInstanceOf(HttpException);
    expect(await prisma.contact.count({where: {projectId}})).toBe(0);
  });

  it('refuses a locale that is not a string', async () => {
    await expect(ContactService.upsertMany(projectId, [{email: 'ada@example.com', data: {locale: 1}}])).rejects.toThrow(
      'Locale must be a string',
    );
  });

  it('loses no key when batches write the same contact at once', async () => {
    await factories.createContact({projectId, email: 'ada@example.com', data: {}});

    await Promise.all(
      Array.from({length: 8}, (_, i) =>
        ContactService.upsertMany(projectId, [{email: 'ada@example.com', data: {[`k${i}`]: i}}]),
      ),
    );

    expect((await stored('ada@example.com')).data).toEqual({k0: 0, k1: 1, k2: 2, k3: 3, k4: 4, k5: 5, k6: 6, k7: 7});
  });

  it('accepts at most 100 contacts per batch', () => {
    const contacts = Array.from({length: 101}, (_, i) => ({email: `c${i}@example.com`}));

    expect(ContactSchemas.batchUpsert.safeParse({contacts}).success).toBe(false);
    expect(ContactSchemas.batchUpsert.safeParse({contacts: contacts.slice(0, 100)}).success).toBe(true);
    expect(ContactSchemas.batchUpsert.safeParse({contacts: []}).success).toBe(false);
  });
});

describe('ContactService.lookup ids', () => {
  it('returns the id of each contact found, under the address as the caller wrote it', async () => {
    const {project} = await factories.createUserWithProject();
    const contact = await factories.createContact({projectId: project.id, email: 'ada@example.com'});

    expect(await ContactService.lookup(project.id, ['ADA@example.com', 'none@example.com'])).toEqual({
      found: ['ADA@example.com'],
      notFound: ['none@example.com'],
      contacts: [{email: 'ADA@example.com', id: contact.id}],
    });
  });
});
