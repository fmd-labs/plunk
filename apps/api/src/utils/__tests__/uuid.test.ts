import {UtilitySchemas} from '@plunk/shared';
import {describe, expect, it} from 'vitest';

import {uuidv5} from '../uuid';

const DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

describe('uuidv5', () => {
  it('matches the published example for a name in the DNS namespace', () => {
    expect(uuidv5('www.example.com', DNS_NAMESPACE)).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });

  it('gives the same UUID for the same name and namespace, and another for any other', () => {
    const namespace = '3d32fa1c-25fe-4376-bf2f-11b83f558336';

    expect(uuidv5('claim:ada@example.com:0', namespace)).toBe(uuidv5('claim:ada@example.com:0', namespace));
    expect(uuidv5('claim:ada@example.com:1', namespace)).not.toBe(uuidv5('claim:ada@example.com:0', namespace));
    expect(uuidv5('claim:ada@example.com:0', DNS_NAMESPACE)).not.toBe(uuidv5('claim:ada@example.com:0', namespace));
  });

  it('produces version 5 UUIDs that pass the API id validation', () => {
    const id = uuidv5('Grüße', DNS_NAMESPACE);

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(UtilitySchemas.id.parse({id})).toEqual({id});
  });
});
