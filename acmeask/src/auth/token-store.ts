/**
 * Token Store — encrypts and stores per-user OAuth tokens in AWS Secrets Manager.
 * Never logs token values. Tokens are keyed by Okta user ID.
 */
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  CreateSecretCommand,
  UpdateSecretCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-secrets-manager';
import { config } from '../config';
import type { UserTokens } from '../types';
import { logger } from '../middleware/logger';

const client = new SecretsManagerClient({ region: config.AWS_REGION });

function secretName(oktaUserId: string): string {
  return `${config.SECRETS_MANAGER_PREFIX}/user-tokens/${oktaUserId}`;
}

export async function getUserTokens(oktaUserId: string): Promise<UserTokens | null> {
  const name = secretName(oktaUserId);
  try {
    const response = await client.send(new GetSecretValueCommand({ SecretId: name }));
    if (!response.SecretString) return null;
    return JSON.parse(response.SecretString) as UserTokens;
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return null;
    logger.error({ err, oktaUserId }, 'Failed to retrieve user tokens');
    throw err;
  }
}

export async function storeUserTokens(tokens: UserTokens): Promise<void> {
  const name = secretName(tokens.oktaUserId);
  const secretValue = JSON.stringify(tokens);

  try {
    await client.send(new UpdateSecretCommand({
      SecretId: name,
      SecretString: secretValue,
    }));
    logger.info({ oktaUserId: tokens.oktaUserId }, 'User tokens updated');
  } catch (err) {
    if (err instanceof ResourceNotFoundException) {
      await client.send(new CreateSecretCommand({
        Name: name,
        SecretString: secretValue,
        Description: `AcmeAsk OAuth tokens for user ${tokens.oktaUserId}`,
        Tags: [
          { Key: 'app', Value: 'acmeask' },
          { Key: 'user', Value: tokens.oktaUserId },
        ],
      }));
      logger.info({ oktaUserId: tokens.oktaUserId }, 'User tokens created');
    } else {
      logger.error({ err, oktaUserId: tokens.oktaUserId }, 'Failed to store user tokens');
      throw err;
    }
  }
}

export async function clearConnectorToken(
  oktaUserId: string,
  connector: 'notion' | 'confluence' | 'googleDrive'
): Promise<void> {
  const existing = await getUserTokens(oktaUserId);
  if (!existing) return;
  const updated = { ...existing };
  delete updated[`${connector}Token` as keyof UserTokens];
  if (connector === 'googleDrive') delete updated.googleDriveRefreshToken;
  await storeUserTokens(updated);
}
