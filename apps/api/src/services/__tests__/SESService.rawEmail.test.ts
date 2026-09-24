import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest';

import {buildRawEmail, sendRawEmail, ses} from '../SESService';

vi.mock('@aws-sdk/client-ses', () => {
  const SESMock = vi.fn();
  SESMock.prototype.sendRawEmail = vi.fn().mockResolvedValue({MessageId: 'test-message-id'});
  return {SES: SESMock};
});

vi.mock('../../app/constants.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../app/constants.js')>()),
  SES_CONFIGURATION_SET: 'tracking-set',
  SES_CONFIGURATION_SET_NO_TRACKING: 'no-tracking-set',
  TRACKING_TOGGLE_ENABLED: true,
}));

const PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

interface GoldenCase {
  name: string;
  params: Parameters<typeof sendRawEmail>[0];
  source: string;
  destinations: string[];
  configurationSetName: string;
  /** The expected MIME message, one entry per line. */
  mime: string[];
}

/**
 * Every MIME layout the builder produces: alternative (three ways, for the text part), related,
 * mixed, and mixed with related. The expected messages are the exact bytes upstream's
 * `sendRawEmail` submitted before building and submitting were split; any change to them is a
 * change to what recipients receive.
 */
const GOLDEN: GoldenCase[] = [
  {
    name: 'HTML body with a derived text part',
    params: {
      from: {name: 'Acme', email: 'hello@acme.test'},
      to: ['ada@example.com'],
      content: {
        subject: 'Welcome aboard',
        html: '<h1>Welcome</h1><p>Grüße! Read the <a href="https://acme.test/docs">docs</a>.</p>',
      },
      // What the email worker passes for an email without attachments.
      attachments: null,
    },
    source: 'Acme <hello@acme.test>',
    destinations: ['ada@example.com'],
    configurationSetName: 'tracking-set',
    mime: [
      'From: Acme <hello@acme.test>',
      'To: ada@example.com',
      'Reply-To: hello@acme.test',
      'Subject: Welcome aboard',
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="----=_AltPart_i"',
      '',
      '------=_AltPart_i',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Welcome',
      '',
      'Gr=C3=BC=C3=9Fe! Read the docs [https://acme.test/docs].',
      '------=_AltPart_i',
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '<h1>Welcome</h1><p>Gr=C3=BC=C3=9Fe! Read the <a href=3D"https://acme.test=',
      '/docs">docs</a>.</p>',
      '------=_AltPart_i--',
      '',
    ],
  },
  {
    name: 'named recipients, reply-to, extra headers and a hand-written text part',
    params: {
      from: {name: 'Acme Support', email: 'support@acme.test'},
      to: [{name: 'Ada Lovelace', email: 'ada@example.com'}, {email: 'bob@example.com'}],
      content: {
        subject: 'Your ticket',
        html: '<p>We replied to your ticket.</p>',
        text: 'We replied to your ticket.',
      },
      reply: 'tickets@acme.test',
      headers: {'List-Unsubscribe': '<https://acme.test/unsubscribe>', 'X-Entity-Ref-ID': 'ticket-42'},
      tracking: false,
    },
    source: 'Acme Support <support@acme.test>',
    destinations: ['ada@example.com', 'bob@example.com'],
    configurationSetName: 'no-tracking-set',
    mime: [
      'From: Acme Support <support@acme.test>',
      'To: Ada Lovelace <ada@example.com>, bob@example.com',
      'Reply-To: tickets@acme.test',
      'Subject: Your ticket',
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="----=_AltPart_i"',
      'List-Unsubscribe: <https://acme.test/unsubscribe>',
      'X-Entity-Ref-ID: ticket-42',
      '',
      '------=_AltPart_i',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'We replied to your ticket.',
      '------=_AltPart_i',
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '<p>We replied to your ticket.</p>',
      '------=_AltPart_i--',
      '',
    ],
  },
  {
    name: 'HTML without readable text',
    params: {
      from: {name: 'Acme', email: 'hello@acme.test'},
      to: ['ada@example.com'],
      content: {subject: 'Banner', html: '<img src="https://acme.test/banner.png">'},
    },
    source: 'Acme <hello@acme.test>',
    destinations: ['ada@example.com'],
    configurationSetName: 'tracking-set',
    mime: [
      'From: Acme <hello@acme.test>',
      'To: ada@example.com',
      'Reply-To: hello@acme.test',
      'Subject: Banner',
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="----=_AltPart_i"',
      '',
      '------=_AltPart_i',
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '<img src=3D"https://acme.test/banner.png">',
      '------=_AltPart_i--',
      '',
    ],
  },
  {
    name: 'regular attachment',
    params: {
      from: {name: 'Acme', email: 'billing@acme.test'},
      to: ['ada@example.com'],
      content: {subject: 'Invoice 42', html: '<p>Your invoice is attached.</p>'},
      attachments: [{filename: 'invoice.txt', content: 'SW52b2ljZSA0Mg==', contentType: 'text/plain'}],
    },
    source: 'Acme <billing@acme.test>',
    destinations: ['ada@example.com'],
    configurationSetName: 'tracking-set',
    mime: [
      'From: Acme <billing@acme.test>',
      'To: ada@example.com',
      'Reply-To: billing@acme.test',
      'Subject: Invoice 42',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="----=_MixedPart_i"',
      '',
      '------=_MixedPart_i',
      'Content-Type: multipart/alternative; boundary="----=_AltPart_i"',
      '',
      '------=_AltPart_i',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Your invoice is attached.',
      '------=_AltPart_i',
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '<p>Your invoice is attached.</p>',
      '------=_AltPart_i--',
      '',
      '------=_MixedPart_i',
      'Content-Type: text/plain',
      'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment; filename="invoice.txt"',
      '',
      'SW52b2ljZSA0Mg==',
      '------=_MixedPart_i--',
    ],
  },
  {
    name: 'inline image without a content ID',
    params: {
      from: {name: 'Acme', email: 'hello@acme.test'},
      to: ['ada@example.com'],
      content: {subject: 'Logo', html: '<p>Hi <img src="cid:logo.png"></p>'},
      attachments: [{filename: 'logo.png', content: PIXEL_PNG, contentType: 'image/png', disposition: 'inline'}],
    },
    source: 'Acme <hello@acme.test>',
    destinations: ['ada@example.com'],
    configurationSetName: 'tracking-set',
    mime: [
      'From: Acme <hello@acme.test>',
      'To: ada@example.com',
      'Reply-To: hello@acme.test',
      'Subject: Logo',
      'MIME-Version: 1.0',
      'Content-Type: multipart/related; boundary="----=_RelatedPart_i"',
      '',
      '------=_RelatedPart_i',
      'Content-Type: multipart/alternative; boundary="----=_AltPart_i"',
      '',
      '------=_AltPart_i',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Hi',
      '------=_AltPart_i',
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '<p>Hi <img src=3D"cid:logo.png"></p>',
      '------=_AltPart_i--',
      '',
      '------=_RelatedPart_i',
      'Content-Type: image/png',
      'Content-Transfer-Encoding: base64',
      'Content-ID: <logo.png>',
      'Content-Disposition: inline; filename="logo.png"',
      '',
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YA',
      'AAAASUVORK5CYII=',
      '------=_RelatedPart_i--',
    ],
  },
  {
    name: 'inline image and regular attachment',
    params: {
      from: {name: 'Acme', email: 'billing@acme.test'},
      to: ['ada@example.com'],
      content: {subject: 'Invoice 43', html: '<p><img src="cid:logo"> Your invoice is attached.</p>'},
      attachments: [
        {filename: 'invoice.txt', content: 'SW52b2ljZSA0Mw==', contentType: 'text/plain', disposition: 'attachment'},
        {filename: 'logo.png', content: PIXEL_PNG, contentType: 'image/png', contentId: 'logo', disposition: 'inline'},
      ],
    },
    source: 'Acme <billing@acme.test>',
    destinations: ['ada@example.com'],
    configurationSetName: 'tracking-set',
    mime: [
      'From: Acme <billing@acme.test>',
      'To: ada@example.com',
      'Reply-To: billing@acme.test',
      'Subject: Invoice 43',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="----=_MixedPart_i"',
      '',
      '------=_MixedPart_i',
      'Content-Type: multipart/related; boundary="----=_RelatedPart_i"',
      '',
      '------=_RelatedPart_i',
      'Content-Type: multipart/alternative; boundary="----=_AltPart_i"',
      '',
      '------=_AltPart_i',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Your invoice is attached.',
      '------=_AltPart_i',
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '<p><img src=3D"cid:logo"> Your invoice is attached.</p>',
      '------=_AltPart_i--',
      '',
      '------=_RelatedPart_i',
      'Content-Type: image/png',
      'Content-Transfer-Encoding: base64',
      'Content-ID: <logo>',
      'Content-Disposition: inline; filename="logo.png"',
      '',
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YA',
      'AAAASUVORK5CYII=',
      '------=_RelatedPart_i--',
      '------=_MixedPart_i',
      'Content-Type: text/plain',
      'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment; filename="invoice.txt"',
      '',
      'SW52b2ljZSA0Mw==',
      '------=_MixedPart_i--',
    ],
  },
];

describe('SES raw email', () => {
  beforeEach(() => {
    // Boundaries are random; pin them so the expected messages can be spelled out byte for byte.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    (ses.sendRawEmail as Mock).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe.each(GOLDEN)('$name', golden => {
    it('builds the expected message', () => {
      expect(buildRawEmail(golden.params)).toEqual({
        source: golden.source,
        destinations: golden.destinations,
        configurationSetName: golden.configurationSetName,
        mime: golden.mime.join('\n'),
      });
      expect(ses.sendRawEmail).not.toHaveBeenCalled();
    });

    it('submits exactly that message to SES', async () => {
      await expect(sendRawEmail(golden.params)).resolves.toEqual({messageId: 'test-message-id'});

      expect(ses.sendRawEmail).toHaveBeenCalledTimes(1);
      const request = (ses.sendRawEmail as Mock).mock.calls[0]?.[0];
      expect({...request, RawMessage: {Data: new TextDecoder().decode(request.RawMessage.Data)}}).toEqual({
        Source: golden.source,
        Destinations: golden.destinations,
        ConfigurationSetName: golden.configurationSetName,
        RawMessage: {Data: golden.mime.join('\n')},
      });
    });
  });
});
