/**
 * Token Store — DynamoDB + KMS envelope encryption
 *
 * Security:
 * - Tokens encrypted with AWS KMS CMK before write; decrypted in-process on read
 * - Never use Secrets Manager per-user (cost: $0.40/secret/month × 30k tokens = $12k/yr)
 * - DynamoDB + one CMK: ~$1/month at 10k users
 */
import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';

export type Provider = 'notion' | 'confluence' | 'gdrive';

export interface StoredToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  issuedAt: string;
  provider: Provider;
  slackUserId: string;
}

export class TokenStore {
  private dynamo: DynamoDBClient;
  private kms: KMSClient;
  private tableName: string;
  private kmsKeyId: string;

  constructor(config: { region: string; tableName: string; kmsKeyId: string }) {
    this.dynamo = new DynamoDBClient({ region: config.region });
    this.kms = new KMSClient({ region: config.region });
    this.tableName = config.tableName;
    this.kmsKeyId = config.kmsKeyId;
  }

  private async encrypt(plaintext: string): Promise<string> {
    const result = await this.kms.send(new EncryptCommand({ KeyId: this.kmsKeyId, Plaintext: Buffer.from(plaintext) }));
    return Buffer.from(result.CiphertextBlob!).toString('base64');
  }

  private async decrypt(ciphertext: string): Promise<string> {
    const result = await this.kms.send(new DecryptCommand({ CiphertextBlob: Buffer.from(ciphertext, 'base64') }));
    return Buffer.from(result.Plaintext!).toString('utf-8');
  }

  async get(slackUserId: string, provider: Provider): Promise<StoredToken | null> {
    const result = await this.dynamo.send(new GetItemCommand({
      TableName: this.tableName,
      Key: { pk: { S: `USER#${slackUserId}` }, sk: { S: `TOKEN#${provider}` } },
    }));
    if (!result.Item) return null;
    const [accessToken, refreshToken] = await Promise.all([
      this.decrypt(result.Item.accessTokenEnc!.S!),
      this.decrypt(result.Item.refreshTokenEnc!.S!),
    ]);
    return { accessToken, refreshToken, expiresAt: result.Item.expiresAt!.S!, issuedAt: result.Item.issuedAt!.S!, provider, slackUserId };
  }

  async put(token: StoredToken): Promise<void> {
    const [accessTokenEnc, refreshTokenEnc] = await Promise.all([
      this.encrypt(token.accessToken),
      this.encrypt(token.refreshToken),
    ]);
    await this.dynamo.send(new PutItemCommand({
      TableName: this.tableName,
      Item: {
        pk: { S: `USER#${token.slackUserId}` },
        sk: { S: `TOKEN#${token.provider}` },
        accessTokenEnc: { S: accessTokenEnc },
        refreshTokenEnc: { S: refreshTokenEnc },
        expiresAt: { S: token.expiresAt },
        issuedAt: { S: token.issuedAt },
        updatedAt: { S: new Date().toISOString() },
      },
    }));
  }

  async getAllForUser(slackUserId: string): Promise<Partial<Record<Provider, StoredToken>>> {
    const providers: Provider[] = ['notion', 'confluence', 'gdrive'];
    const results = await Promise.allSettled(providers.map(p => this.get(slackUserId, p)));
    const tokens: Partial<Record<Provider, StoredToken>> = {};
    for (let i = 0; i < providers.length; i++) {
      const r = results[i]!;
      if (r.status === 'fulfilled' && r.value) tokens[providers[i]!] = r.value;
    }
    return tokens;
  }
}
