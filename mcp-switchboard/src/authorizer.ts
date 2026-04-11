/**
 * Lambda authorizer — validates Authorization: Bearer <token> header against
 * a token stored in Secrets Manager. Attached to all API Gateway routes.
 * Caches the token in module scope for warm Lambdas.
 *
 * The bearer token is stored in the Anthropic vault as an MCP credential.
 * The vault sends it automatically on every request — no agent config needed.
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { APIGatewayRequestSimpleAuthorizerHandlerV2 } from 'aws-lambda';

const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
const SECRET_ID = process.env.BEARER_TOKEN_SECRET_ID ?? 'mcp-switchboard/bearer-token';

let cachedToken: string | undefined;

async function getBearerToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  const response = await client.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
  if (!response.SecretString) throw new Error('Bearer token secret has no value');
  cachedToken = response.SecretString;
  return cachedToken;
}

export const handler: APIGatewayRequestSimpleAuthorizerHandlerV2 = async (event) => {
  const authHeader = event.headers?.['authorization'];
  if (!authHeader?.startsWith('Bearer ')) return { isAuthorized: false };

  const provided = authHeader.slice(7);

  try {
    const expected = await getBearerToken();
    return { isAuthorized: provided === expected };
  } catch {
    return { isAuthorized: false };
  }
};
