import {describe, expect, it} from 'vitest';

import {applyLayout, layoutHasUnsubscribeLink, layoutSlotCount, withStyleBlock} from '../layout.js';
import {LayoutSchemas} from '../schemas/index.js';

/** Layouts (fork D34). */
describe('layouts', () => {
  it('count the {{ content }} slots, with Liquid whitespace control', () => {
    expect(layoutSlotCount('<p>{{ content }}</p>')).toBe(1);
    expect(layoutSlotCount('<p>{{content}}</p><p>{{- content -}}</p>')).toBe(2);
    expect(layoutSlotCount('<p>{{ contents }}</p>{{ data.content }}')).toBe(0);
  });

  it('put the body into the slot as it is written', () => {
    expect(applyLayout('<main>{{ content }}</main>', '<p>$& $1 {{ name }}</p>')).toBe(
      '<main><p>$& $1 {{ name }}</p></main>',
    );
  });

  it('tell a layout that links to the unsubscribe page', () => {
    expect(layoutHasUnsubscribeLink('<a href="{{ unsubscribeUrl }}">x</a>')).toBe(true);
    expect(layoutHasUnsubscribeLink('<a href="{{manageUrl | default: "#"}}">x</a>')).toBe(true);
    expect(layoutHasUnsubscribeLink('<p>{{ content }}</p>')).toBe(false);
  });

  it('put CSS into the head, else after the html tag, else ahead of the document', () => {
    expect(withStyleBlock('<html><head><title>x</title></head></html>', 'p{}')).toBe(
      '<html><head><style>p{}</style><title>x</title></head></html>',
    );
    expect(withStyleBlock('<!doctype html><html lang="en"><body><header>x</header></body></html>', 'p{}')).toBe(
      '<!doctype html><html lang="en"><style>p{}</style><body><header>x</header></body></html>',
    );
    expect(withStyleBlock('<p>x</p>', 'p{}')).toBe('<style>p{}</style><p>x</p>');
  });

  it('need exactly one slot to be saved', () => {
    expect(LayoutSchemas.upsert.safeParse({name: 'A', html: '<p>{{ content }}</p>'}).success).toBe(true);
    expect(LayoutSchemas.upsert.safeParse({name: 'A', html: '<p>no slot</p>'}).success).toBe(false);
    expect(LayoutSchemas.upsert.safeParse({name: 'A', html: '{{ content }}{{ content }}'}).success).toBe(false);
  });
});
