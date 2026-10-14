import type {SegmentFilter} from '@plunk/types';
import {beforeEach, describe, expect, it} from 'vitest';

import {factories} from '../../../../../test/helpers';
import {HttpException} from '../../exceptions';
import {ContactService} from '../ContactService';
import {SegmentService} from '../SegmentService';
import {WorkflowService} from '../WorkflowService';

/** The array operators on custom data fields (D31). */
describe('SegmentService array operators', () => {
  let projectId: string;
  let ids: Record<string, string>;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;

    const contacts = {
      enDe: {languages: ['en', 'de'], scores: [1, 2]},
      en: {languages: ['en']},
      fr: {languages: ['fr']},
      empty: {languages: []},
      text: {languages: 'en, de'},
      none: {},
    };
    ids = {};
    for (const [name, data] of Object.entries(contacts)) {
      ids[name] = (await factories.createContact({projectId, email: `${name}@example.com`, data})).id;
    }
  });

  async function matches(filter: SegmentFilter): Promise<string[]> {
    const segment = await factories.createSegment(projectId, {filters: [filter]});
    const result = await SegmentService.getContacts(projectId, segment.id, 1, 100);
    const byId = Object.fromEntries(Object.entries(ids).map(([name, id]) => [id, name]));
    return result.data.map((contact: {id: string}) => byId[contact.id]!).sort();
  }

  it('includesAny matches an array holding at least one of the values', async () => {
    expect(await matches({field: 'data.languages', operator: 'includesAny', value: ['de', 'fr']})).toEqual([
      'enDe',
      'fr',
    ]);
  });

  it('includesAll matches an array holding every one of the values', async () => {
    expect(await matches({field: 'data.languages', operator: 'includesAll', value: ['en', 'de']})).toEqual(['enDe']);
    expect(await matches({field: 'data.languages', operator: 'includesAll', value: ['en']})).toEqual(['en', 'enDe']);
  });

  it('includesNone matches only arrays holding none of the values', async () => {
    expect(await matches({field: 'data.languages', operator: 'includesNone', value: ['en']})).toEqual(['empty', 'fr']);
  });

  it('takes a single value as a list of one', async () => {
    expect(await matches({field: 'data.languages', operator: 'includesAny', value: 'fr'})).toEqual(['fr']);
  });

  it('compares items as JSON values: a string does not match a number', async () => {
    expect(await matches({field: 'data.scores', operator: 'includesAny', value: [2]})).toEqual(['enDe']);
    expect(await matches({field: 'data.scores', operator: 'includesAny', value: ['2']})).toEqual([]);
  });

  it('refuses an array operator without values, with non-scalar values, or outside data fields', async () => {
    for (const filter of [
      {field: 'data.languages', operator: 'includesAny', value: []},
      {field: 'data.languages', operator: 'includesAll', value: [{a: 1}]},
      {field: 'data.languages', operator: 'includesAll', value: ['de', null]},
      {field: 'data.languages', operator: 'includesNone', value: ['en', {code: 'en'}]},
      {field: 'data.languages', operator: 'includesAny', value: Array.from({length: 101}, (_, i) => `l${i}`)},
      {field: 'data.languages', operator: 'includesNone'},
      {field: 'email', operator: 'includesAny', value: ['x']},
    ] as SegmentFilter[]) {
      await expect(
        SegmentService.create(projectId, {
          name: 'Invalid',
          condition: {logic: 'AND', groups: [{filters: [filter]}]},
        }),
      ).rejects.toBeInstanceOf(HttpException);
    }
  });

  it('reports a field any contact holds an array in with the array type and its items type', async () => {
    const fields = await ContactService.getAvailableFields(projectId);

    expect(fields.find(field => field.field === 'data.scores')).toMatchObject({type: 'array', itemType: 'number'});
    // `languages` is a string for one contact and an array for the others.
    expect(fields.find(field => field.field === 'data.languages')).toMatchObject({type: 'array', itemType: 'string'});
  });

  it('reports array fields as text to workflow conditions, which have no array operators', async () => {
    const {typedFields} = await WorkflowService.getAvailableFields(projectId);

    expect(typedFields.find(field => field.field === 'contact.data.languages')?.type).toBe('string');
  });
});
