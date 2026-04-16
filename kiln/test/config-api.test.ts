/**
 * Config API tests.
 * Uses aws-sdk-client-mock to mock DynamoDB calls.
 */
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// Mock DynamoDB before importing the handler
const ddbMock = mockClient(DynamoDBDocumentClient);

import { handler } from '../lambda/config-api/index';

type LambdaResult = { statusCode: number; body?: string; headers?: Record<string, string> };

function makeEvent(
  method: string,
  path: string,
  body?: unknown,
  teamId = 'team-alpha',
): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: `${method} ${path}`,
    rawPath: path,
    rawQueryString: '',
    headers: { 'content-type': 'application/json' },
    requestContext: {
      accountId: '123456789',
      apiId: 'test',
      domainName: 'test.execute-api.us-east-1.amazonaws.com',
      domainPrefix: 'test',
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'test-request-id',
      routeKey: `${method} ${path}`,
      stage: '$default',
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
      authorizer: {
        lambda: { teamId, sub: `user@example.com` },
      },
    } as APIGatewayProxyEventV2['requestContext'],
    isBase64Encoded: false,
    body: body ? JSON.stringify(body) : undefined,
  } as unknown as APIGatewayProxyEventV2;
}

const validConfig = {
  githubOrg: 'acme',
  watchedRepos: ['api-service'],
  watchedPackages: [{ name: 'react', policy: 'latest', skipVersions: [] }],
  grouping: { strategy: 'per-dep' },
  reviewSlaHours: 48,
};

beforeEach(() => {
  ddbMock.reset();
  // Default: mock audit write (PutCommand on audit table)
  ddbMock.on(PutCommand).resolves({});
});

describe('GET /teams/{teamId}/config', () => {
  it('returns 200 with config when it exists', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { teamId: 'team-alpha', ...validConfig, createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' },
    });

    const event = makeEvent('GET', '/teams/team-alpha/config');
    const result = (await handler(event)) as LambdaResult;

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body ?? '{}');
    expect(body.data.teamId).toBe('team-alpha');
  });

  it('returns 404 when config does not exist', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const event = makeEvent('GET', '/teams/team-alpha/config');
    const result = (await handler(event)) as LambdaResult;

    expect(result.statusCode).toBe(404);
  });

  it('returns 403 when caller teamId does not match path teamId', async () => {
    const event = makeEvent('GET', '/teams/team-beta/config', undefined, 'team-alpha');
    const result = (await handler(event)) as LambdaResult;
    expect(result.statusCode).toBe(403);
  });
});

describe('POST /teams/{teamId}/config', () => {
  it('creates config and returns 201', async () => {
    ddbMock.on(PutCommand).resolves({});

    const event = makeEvent('POST', '/teams/team-alpha/config', validConfig);
    const result = (await handler(event)) as LambdaResult;

    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body ?? '{}');
    expect(body.data.teamId).toBe('team-alpha');
    expect(body.data.githubOrg).toBe('acme');
  });

  it('returns 400 for invalid JSON body', async () => {
    const event = makeEvent('POST', '/teams/team-alpha/config');
    (event as unknown as { body: string }).body = 'not json';
    const result = (await handler(event)) as LambdaResult;
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 when githubOrg is missing', async () => {
    const event = makeEvent('POST', '/teams/team-alpha/config', { ...validConfig, githubOrg: '' });
    const result = (await handler(event)) as LambdaResult;
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 when grouping strategy is invalid', async () => {
    const event = makeEvent('POST', '/teams/team-alpha/config', { ...validConfig, grouping: { strategy: 'unknown' } });
    const result = (await handler(event)) as LambdaResult;
    expect(result.statusCode).toBe(400);
  });
});

describe('PUT /teams/{teamId}/config', () => {
  it('updates config and returns 200', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { teamId: 'team-alpha', ...validConfig, createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' },
    });
    ddbMock.on(PutCommand).resolves({});

    const event = makeEvent('PUT', '/teams/team-alpha/config', { ...validConfig, reviewSlaHours: 72 });
    const result = (await handler(event)) as LambdaResult;

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body ?? '{}');
    expect(body.data.reviewSlaHours).toBe(72);
  });

  it('returns 404 when updating non-existent config', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    const event = makeEvent('PUT', '/teams/team-alpha/config', validConfig);
    const result = (await handler(event)) as LambdaResult;
    expect(result.statusCode).toBe(404);
  });
});

describe('DELETE /teams/{teamId}/config', () => {
  it('deletes config and returns 200', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { teamId: 'team-alpha', ...validConfig },
    });
    ddbMock.on(DeleteCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});

    const event = makeEvent('DELETE', '/teams/team-alpha/config');
    const result = (await handler(event)) as LambdaResult;
    expect(result.statusCode).toBe(200);
  });

  it('returns 404 when deleting non-existent config', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    const event = makeEvent('DELETE', '/teams/team-alpha/config');
    const result = (await handler(event)) as LambdaResult;
    expect(result.statusCode).toBe(404);
  });
});

describe('GET /teams/{teamId}/prs', () => {
  it('returns PR list', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ teamId: 'team-alpha', prId: 'react#18.0.0', status: 'opened' }],
    });

    const event = makeEvent('GET', '/teams/team-alpha/prs');
    const result = (await handler(event)) as LambdaResult;
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body ?? '{}');
    expect(body.data).toHaveLength(1);
  });
});

describe('GET /teams/{teamId}/prs/{prId}', () => {
  it('returns specific PR', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { teamId: 'team-alpha', prId: 'react#18.0.0', status: 'opened' },
    });

    const event = makeEvent('GET', '/teams/team-alpha/prs/react%2318.0.0');
    const result = (await handler(event)) as LambdaResult;
    expect(result.statusCode).toBe(200);
  });

  it('returns 404 for missing PR', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    const event = makeEvent('GET', '/teams/team-alpha/prs/missing%23pr');
    const result = (await handler(event)) as LambdaResult;
    expect(result.statusCode).toBe(404);
  });
});

describe('auth enforcement', () => {
  it('returns 401 when authorizer context is missing', async () => {
    const event = makeEvent('GET', '/teams/team-alpha/config');
    // Remove authorizer context
    (event.requestContext as unknown as { authorizer?: unknown }).authorizer = undefined;
    const result = (await handler(event)) as LambdaResult;
    expect(result.statusCode).toBe(401);
  });
});
