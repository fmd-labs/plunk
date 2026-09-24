import {SES} from '@aws-sdk/client-ses';
import {beforeAll, describe, expect, it, vi} from 'vitest';

import {sendRawEmail, submitRawEmail} from '../SESService';

vi.mock('@aws-sdk/client-ses', () => {
  const SESMock = vi.fn();
  SESMock.prototype.sendRawEmail = vi.fn(async () => ({MessageId: 'ses-message-id'}));
  return {SES: SESMock};
});

describe('SES clients', () => {
  let clients: {config: unknown; instance: unknown}[];

  beforeAll(() => {
    // The clients are created when the module loads; read them before the reset after each test
    // clears the recorded calls.
    const {calls, instances} = vi.mocked(SES).mock;
    clients = calls.map(([config], index) => ({config, instance: instances[index]}));
  });

  /** The configuration of the client the last message went through. */
  function lastSendClientConfig() {
    const client = vi.mocked(SES.prototype.sendRawEmail).mock.contexts.at(-1);
    return clients.find(({instance}) => instance === client)?.config;
  }

  it('submits messages in a single attempt, with timeouts', async () => {
    await submitRawEmail({
      source: 'from@example.com',
      destinations: ['to@example.com'],
      configurationSetName: 'configuration-set',
      mime: '',
    });

    expect(lastSendClientConfig()).toMatchObject({
      maxAttempts: 1,
      requestHandler: {connectionTimeout: 5_000, requestTimeout: 30_000, throwOnRequestTimeout: true},
    });
  });

  it('keeps the SDK retries for test sends and every other call', async () => {
    await sendRawEmail({
      from: {name: 'Sender', email: 'from@example.com'},
      to: ['to@example.com'],
      content: {subject: 'Test', html: '<p>Test</p>'},
    });

    expect(clients).toHaveLength(2);
    expect(lastSendClientConfig()).toBeDefined();
    expect(lastSendClientConfig()).not.toHaveProperty('maxAttempts');
  });
});
