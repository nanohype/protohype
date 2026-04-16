/**
 * Audit log writer tests.
 */
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

const ddbMock = mockClient(DynamoDBDocumentClient);
const sqsMock = mockClient(SQSClient);

import { writeAuditEvent } from '../lambda/shared/audit';

beforeEach(() => {
  ddbMock.reset();
  sqsMock.reset();
  process.env.KILN_AUDIT_DLQ_URL = 'https://sqs.us-east-1.amazonaws.com/123456789/kiln-audit-dlq';
});

afterEach(() => {
  delete process.env.KILN_AUDIT_DLQ_URL;
});

describe('writeAuditEvent', () => {
  it('writes to DynamoDB successfully', async () => {
    ddbMock.on(PutCommand).resolves({});

    await expect(writeAuditEvent({
      teamId: 'team-alpha',
      action: 'config.created',
      actorIdentity: 'user@example.com',
      metadata: { foo: 'bar' },
    })).resolves.toBeUndefined();

    const calls = ddbMock.commandCalls(PutCommand);
    expect(calls).toHaveLength(1);
    const item = calls[0]!.args[0].input.Item as Record<string, unknown>;
    expect(item['teamId']).toBe('team-alpha');
    expect(item['action']).toBe('config.created');
    expect(item['actorIdentity']).toBe('user@example.com');
    expect(typeof item['expiresAt']).toBe('number');
  });

  it('routes to DLQ on DynamoDB error when DLQ is configured', async () => {
    ddbMock.on(PutCommand).rejects(new Error('ProvisionedThroughputExceededException'));
    sqsMock.on(SendMessageCommand).resolves({ MessageId: 'dlq-msg-id' });

    await expect(writeAuditEvent({
      teamId: 'team-alpha',
      action: 'config.updated',
      actorIdentity: 'user@example.com',
    })).resolves.toBeUndefined();

    const sqsCalls = sqsMock.commandCalls(SendMessageCommand);
    expect(sqsCalls).toHaveLength(1);
  });

  it('throws when DynamoDB fails and no DLQ is configured', async () => {
    ddbMock.on(PutCommand).rejects(new Error('DynamoDB error'));
    delete process.env.KILN_AUDIT_DLQ_URL;

    await expect(writeAuditEvent({
      teamId: 'team-alpha',
      action: 'config.deleted',
      actorIdentity: 'user@example.com',
    })).rejects.toThrow('Audit write failed');
  });

  it('sets 1-year TTL on audit events', async () => {
    ddbMock.on(PutCommand).resolves({});

    const before = Math.floor(Date.now() / 1000);
    await writeAuditEvent({ teamId: 'team-alpha', action: 'pr.opened', actorIdentity: 'system' });
    const after = Math.floor(Date.now() / 1000);

    const calls = ddbMock.commandCalls(PutCommand);
    const item = calls[0]!.args[0].input.Item as Record<string, unknown>;
    const expiresAt = item['expiresAt'] as number;

    const oneYear = 365 * 24 * 60 * 60;
    expect(expiresAt).toBeGreaterThanOrEqual(before + oneYear - 5);
    expect(expiresAt).toBeLessThanOrEqual(after + oneYear + 5);
  });
});
