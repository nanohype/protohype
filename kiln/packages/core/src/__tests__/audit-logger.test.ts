import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { writeAuditEvent, AUDIT_TABLE } from '../audit-logger.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

describe('writeAuditEvent', () => {
  it('writes an event to DynamoDB with all required fields', async () => {
    ddbMock.on(PutCommand).resolves({});

    const client = DynamoDBDocumentClient.from({} as never);
    await writeAuditEvent(
      'PR_OPENED',
      'team-alpha',
      'alice@nanocorp.com',
      { prUrl: 'https://github.com/org/repo/pull/42' },
      client,
    );

    const calls = ddbMock.commandCalls(PutCommand);
    expect(calls).toHaveLength(1);

    const item = calls[0]!.args[0].input.Item as Record<string, unknown>;
    expect(item['eventType']).toBe('PR_OPENED');
    expect(item['teamId']).toBe('team-alpha');
    expect(item['actor']).toBe('alice@nanocorp.com');
    expect(item['payload']).toMatchObject({ prUrl: expect.any(String) });
    expect(typeof item['eventId']).toBe('string');
    expect(typeof item['timestamp']).toBe('string');
    expect(typeof item['ttl']).toBe('number');
  });

  it('writes to the correct table', async () => {
    ddbMock.on(PutCommand).resolves({});

    const client = DynamoDBDocumentClient.from({} as never);
    await writeAuditEvent('CONFIG_READ', 'team-beta', 'bot', {}, client);

    const calls = ddbMock.commandCalls(PutCommand);
    expect(calls[0]!.args[0].input.TableName).toBe(AUDIT_TABLE);
  });

  it('sets a TTL approximately one year in the future', async () => {
    ddbMock.on(PutCommand).resolves({});

    const before = Math.floor(Date.now() / 1000);
    const client = DynamoDBDocumentClient.from({} as never);
    await writeAuditEvent('UPGRADE_TRIGGERED', 'team-alpha', 'bot', {}, client);
    const after = Math.floor(Date.now() / 1000);

    const calls = ddbMock.commandCalls(PutCommand);
    const ttl = calls[0]!.args[0].input.Item?.['ttl'] as number;

    const oneYear = 365 * 24 * 3600;
    expect(ttl).toBeGreaterThanOrEqual(before + oneYear - 5);
    expect(ttl).toBeLessThanOrEqual(after + oneYear + 5);
  });

  it('generates a unique eventId for each call', async () => {
    ddbMock.on(PutCommand).resolves({});

    const client = DynamoDBDocumentClient.from({} as never);
    await writeAuditEvent('CONFIG_READ', 't', 'a', {}, client);
    await writeAuditEvent('CONFIG_READ', 't', 'a', {}, client);

    const calls = ddbMock.commandCalls(PutCommand);
    const id1 = calls[0]!.args[0].input.Item?.['eventId'];
    const id2 = calls[1]!.args[0].input.Item?.['eventId'];
    expect(id1).not.toBe(id2);
  });

  it('propagates DynamoDB errors (audit writes are not swallowed)', async () => {
    ddbMock.on(PutCommand).rejects(new Error('DynamoDB throttle'));

    const client = DynamoDBDocumentClient.from({} as never);
    await expect(
      writeAuditEvent('PR_OPENED', 'team', 'actor', {}, client),
    ).rejects.toThrow('DynamoDB throttle');
  });

  it('supports all audit event types', async () => {
    ddbMock.on(PutCommand).resolves({});
    const client = DynamoDBDocumentClient.from({} as never);

    const types = [
      'PR_OPENED',
      'CONFIG_READ',
      'CONFIG_WRITTEN',
      'CHANGELOG_FETCHED',
      'UPGRADE_TRIGGERED',
      'BREAKING_CHANGE_FLAGGED',
      'RATE_LIMIT_EXCEEDED',
    ] as const;

    for (const type of types) {
      await writeAuditEvent(type, 'team', 'actor', {}, client);
    }

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(types.length);
  });
});
