import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { consumeGitHubToken, RATE_LIMIT_TABLE } from '../rate-limiter.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

describe('consumeGitHubToken', () => {
  it('returns allowed:true with remaining count when capacity exists', async () => {
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { count: 42, resetAt: Date.now() + 3_600_000 },
    });

    const client = DynamoDBDocumentClient.from({} as never);
    const result = await consumeGitHubToken(client, 1);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(5000 - 42);
  });

  it('returns allowed:false when ConditionalCheckFailedException is thrown', async () => {
    const err = Object.assign(new Error('ConditionalCheckFailed'), {
      name: 'ConditionalCheckFailedException',
    });
    ddbMock.on(UpdateCommand).rejects(err);

    const client = DynamoDBDocumentClient.from({} as never);
    const result = await consumeGitHubToken(client, 1);

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('re-throws unexpected DynamoDB errors', async () => {
    ddbMock.on(UpdateCommand).rejects(new Error('Internal server error'));

    const client = DynamoDBDocumentClient.from({} as never);
    await expect(consumeGitHubToken(client, 1)).rejects.toThrow(
      'Internal server error',
    );
  });

  it('sends request to the correct table', async () => {
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { count: 1, resetAt: Date.now() + 3_600_000 },
    });

    const client = DynamoDBDocumentClient.from({} as never);
    await consumeGitHubToken(client, 1);

    const calls = ddbMock.commandCalls(UpdateCommand);
    expect(calls[0]!.args[0].input.TableName).toBe(RATE_LIMIT_TABLE);
  });

  it('encodes the window start in the partition key', async () => {
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { count: 1 },
    });

    const before = Date.now();
    const client = DynamoDBDocumentClient.from({} as never);
    await consumeGitHubToken(client, 1);
    const after = Date.now();

    const calls = ddbMock.commandCalls(UpdateCommand);
    const pk = calls[0]!.args[0].input.Key?.['pk'] as string;
    expect(pk).toMatch(/^github-rate#\d+$/);

    // The window start should be ≤ before rounded to hour boundary
    const windowStart = parseInt(pk.split('#')[1]!, 10);
    expect(windowStart).toBeLessThanOrEqual(before);
    expect(windowStart).toBeLessThanOrEqual(after);
  });

  it('passes cost to the update expression', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { count: 5 } });

    const client = DynamoDBDocumentClient.from({} as never);
    await consumeGitHubToken(client, 5);

    const calls = ddbMock.commandCalls(UpdateCommand);
    const values = calls[0]!.args[0].input.ExpressionAttributeValues;
    expect(values?.[':cost']).toBe(5);
  });
});
