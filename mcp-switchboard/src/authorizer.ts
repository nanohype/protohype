/**
 * Lambda authorizer — validates x-api-key header against a key stored in Secrets Manager.
 * Attached to all API Gateway routes. Caches the key in module scope for warm Lambdas.
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { APIGatewayRequestSimpleAuthorizerHandlerV2 } from 'aws-lambda';

const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
const SECRET_ID = process.env.API_KEY_SECRET_ID ?? 'mcp-switchboard/api-key';

let cachedKey: string | undefined;

async function getApiKey(): Promise<string> {
  if (cachedKey) return cachedKey;
  const response = await client.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
  if (!response.SecretString) throw new Error('API key secret has no value');
  cachedKey = response.SecretString;
  return cachedKey;
}

export const handler: APIGatewayRequestSimpleAuthorizerHandlerV2 = async (event) => {
  const provided = event.headers?.['x-api-key'];
  if (!provided) return { isAuthorized: false };

  try {
    const expected = await getApiKey();
    return { isAuthorized: provided === expected };
  } catch {
    return { isAuthorized: false };
  }
};
