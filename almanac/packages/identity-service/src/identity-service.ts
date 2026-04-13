/**
 * Identity service for Almanac.
 *
 * Token storage: AES-256-GCM, ONE shared key in Secrets Manager.
 * NOT one Secrets Manager secret per user (would cost $4k/mo at 10k users).
 * DynamoDB PAY_PER_REQUEST scales to 10k+ users at ~$40/mo.
 *
 * SCIM deprovisioning: token deletion triggered on Okta offboarding webhook.
 */

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  DeleteItemCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import axios from "axios";

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION });
const sm = new SecretsManagerClient({ region: process.env.AWS_REGION });
const TOKEN_TABLE = process.env.TOKEN_TABLE!;

type SourceSystem = "notion" | "confluence" | "gdrive";

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope: string[];
}

let cachedKey: Buffer | null = null;

async function getEncryptionKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;
  const r = await sm.send(new GetSecretValueCommand({ SecretId: process.env.TOKEN_ENCRYPTION_SECRET_ID! }));
  cachedKey = Buffer.from(JSON.parse(r.SecretString!).key, "hex");
  return cachedKey;
}

async function encryptToken(plain: string): Promise<{ ciphertext: string; iv: string }> {
  const key = await getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: Buffer.concat([enc, tag]).toString("base64"), iv: iv.toString("base64") };
}

async function decryptToken(ciphertext: string, iv: string): Promise<string> {
  const key = await getEncryptionKey();
  const ivBuf = Buffer.from(iv, "base64");
  const data = Buffer.from(ciphertext, "base64");
  const tag = data.slice(-16);
  const enc = data.slice(0, -16);
  const decipher = createDecipheriv("aes-256-gcm", key, ivBuf);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

export class IdentityService {
  // Short-lived in-process cache for Slack->Okta resolution
  private readonly cache = new Map<string, { oktaId: string; exp: number }>();
  private readonly CACHE_TTL = 5 * 60 * 1000;

  async slackToOkta(slackUserId: string): Promise<string | null> {
    const cached = this.cache.get(slackUserId);
    if (cached && cached.exp > Date.now()) return cached.oktaId;
    try {
      const profile = await axios.get(`https://slack.com/api/users.info?user=${slackUserId}`, {
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      });
      const email = profile.data?.user?.profile?.email;
      if (!email) return null;
      const okta = await axios.get(`https://${process.env.OKTA_DOMAIN}/api/v1/users/${encodeURIComponent(email)}`, {
        headers: { Authorization: `SSWS ${process.env.OKTA_API_TOKEN}` },
      });
      const oktaId = okta.data?.id;
      if (!oktaId) return null;
      this.cache.set(slackUserId, { oktaId, exp: Date.now() + this.CACHE_TTL });
      return oktaId;
    } catch (err) {
      console.error("[IdentityService] slackToOkta error:", err);
      return null;
    }
  }

  async hasAnyTokens(oktaUserId: string): Promise<boolean> {
    const r = await dynamo.send(new QueryCommand({
      TableName: TOKEN_TABLE,
      KeyConditionExpression: "oktaUserId = :uid",
      ExpressionAttributeValues: marshall({ ":uid": oktaUserId }),
      Limit: 1,
    }));
    return (r.Count ?? 0) > 0;
  }

  async getTokens(oktaUserId: string, source: SourceSystem): Promise<OAuthTokens | null> {
    const r = await dynamo.send(new GetItemCommand({
      TableName: TOKEN_TABLE,
      Key: marshall({ oktaUserId, sk: `source#${source}` }),
    }));
    if (!r.Item) return null;
    const item = unmarshall(r.Item) as any;
    if (item.tokenExpiry < Math.floor(Date.now() / 1000) + 300) {
      // Refresh needed -- handled in oauth-callbacks.ts
      return null;
    }
    return {
      accessToken: await decryptToken(item.encryptedAccessToken, item.iv),
      refreshToken: item.encryptedRefreshToken ? await decryptToken(item.encryptedRefreshToken, item.ivRefresh) : undefined,
      expiresAt: item.tokenExpiry,
      scope: item.scope,
    };
  }

  async storeTokens(oktaUserId: string, source: SourceSystem, tokens: OAuthTokens): Promise<void> {
    const { ciphertext: encAcc, iv } = await encryptToken(tokens.accessToken);
    let encRef: string | undefined, ivRef: string | undefined;
    if (tokens.refreshToken) {
      const r = await encryptToken(tokens.refreshToken);
      encRef = r.ciphertext;
      ivRef = r.iv;
    }
    await dynamo.send(new PutItemCommand({
      TableName: TOKEN_TABLE,
      Item: marshall({
        oktaUserId,
        sk: `source#${source}`,
        encryptedAccessToken: encAcc,
        encryptedRefreshToken: encRef,
        iv,
        ivRefresh: ivRef,
        tokenExpiry: tokens.expiresAt,
        scope: tokens.scope,
        updatedAt: new Date().toISOString(),
      }, { removeUndefinedValues: true }),
    }));
  }

  /** SCIM deprovisioning -- called on Okta offboarding webhook */
  async deprovisionUser(oktaUserId: string): Promise<void> {
    await Promise.all(
      (["notion", "confluence", "gdrive"] as SourceSystem[]).map((src) =>
        dynamo.send(new DeleteItemCommand({
          TableName: TOKEN_TABLE,
          Key: marshall({ oktaUserId, sk: `source#${src}` }),
        })).catch((e) => console.error(`[Identity] deprovision ${src} error:`, e))
      )
    );
    console.log(`[Identity] Deprovisioned all tokens for ${oktaUserId}`);
  }
}
