/**
 * Kiln health check Lambda.
 * /healthz — returns 200 if the function is running.
 * /readyz  — additionally checks DynamoDB connectivity.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../shared/dynamo';

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const path = event.requestContext.http.path;

  if (path === '/healthz') {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'ok', service: 'kiln', ts: new Date().toISOString() }),
    };
  }

  if (path === '/readyz') {
    try {
      // Probe DynamoDB with a known-non-existent key
      await docClient.send(new GetCommand({
        TableName: TABLE_NAMES.TEAM_CONFIG,
        Key: { teamId: '__health_probe__' },
      }));
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'ready', service: 'kiln', ts: new Date().toISOString() }),
      };
    } catch (err) {
      return {
        statusCode: 503,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'not-ready',
          service: 'kiln',
          error: err instanceof Error ? err.message : 'Unknown error',
          ts: new Date().toISOString(),
        }),
      };
    }
  }

  return {
    statusCode: 404,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: 'NOT_FOUND' }),
  };
};
