/**
 * Rate limiter tests.
 */
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';

const ddbMock = mockClient(DynamoDBDocumentClient);

import { consumeTokens, RateLimitExceeded } from '../lambda/shared/rate-limiter';

beforeEach(() => {
  ddbMock.reset();
});

describe('consumeTokens', () => {
  it('initialises bucket on first use and succeeds', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });   // no existing bucket
    ddbMock.on(UpdateCommand).resolves({});

    await expect(consumeTokens('github-api:org1', 1)).resolves.toBeUndefined();
  });

  it('succeeds when bucket has sufficient tokens', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { bucketKey: 'github-api:org1', tokens: 1000, lastRefillAt: Math.floor(Date.now() / 1000) - 10 },
    });
    ddbMock.on(UpdateCommand).resolves({});

    await expect(consumeTokens('github-api:org1', 5)).resolves.toBeUndefined();
  });

  it('throws RateLimitExceeded when bucket is empty', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { bucketKey: 'github-api:org1', tokens: 0, lastRefillAt: Math.floor(Date.now() / 1000) },
    });

    await expect(consumeTokens('github-api:org1', 10)).rejects.toThrow(RateLimitExceeded);
  });

  it('RateLimitExceeded has retryAfterSeconds', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { bucketKey: 'github-api:org1', tokens: 0, lastRefillAt: Math.floor(Date.now() / 1000) },
    });

    let err: RateLimitExceeded | null = null;
    try {
      await consumeTokens('github-api:org1', 1);
    } catch (e) {
      err = e as RateLimitExceeded;
    }

    expect(err).not.toBeNull();
    expect(typeof err!.retryAfterSeconds).toBe('number');
    expect(err!.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('retries on ConditionalCheckFailedException', async () => {
    let callCount = 0;
    ddbMock.on(GetCommand).callsFake(() => ({
      Item: { bucketKey: 'github-api:org1', tokens: 1000, lastRefillAt: Math.floor(Date.now() / 1000) - 5 },
    }));
    ddbMock.on(UpdateCommand).callsFake(() => {
      callCount++;
      if (callCount === 1) {
        throw new ConditionalCheckFailedException({ message: 'conflict', $metadata: {} });
      }
      return {};
    });

    await expect(consumeTokens('github-api:org1', 1)).resolves.toBeUndefined();
    expect(callCount).toBe(2);  // first call throws, second succeeds
  });

  it('refills tokens over time', async () => {
    // Bucket was last refilled 3600 seconds ago with 0 tokens
    // Should now be back to full capacity
    const longAgo = Math.floor(Date.now() / 1000) - 3600;
    ddbMock.on(GetCommand).resolves({
      Item: { bucketKey: 'github-api:org1', tokens: 0, lastRefillAt: longAgo },
    });
    ddbMock.on(UpdateCommand).resolves({});

    await expect(consumeTokens('github-api:org1', 100)).resolves.toBeUndefined();
  });
});
