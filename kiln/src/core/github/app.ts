/**
 * GitHub App authentication.
 * - Private key + App ID loaded from Secrets Manager with 5-min TTL cache.
 * - Mints short-lived installation tokens (1-hour JWT → installation token).
 * - Never uses PATs or shared bot accounts.
 */
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { createPrivateKey, createSign } from "crypto";
import { config } from "../../config.js";
import { log } from "../../telemetry/otel.js";
import type { GitHubAppSecret, InstallationToken } from "../../types.js";

const secretsClient = new SecretsManagerClient({
  region: config.aws.region,
  requestHandler: { requestTimeout: 10_000 },
});

// 5-minute TTL cache for the app secret
let cachedSecret: { value: GitHubAppSecret; fetchedAt: number; versionId: string } | null = null;
const SECRET_TTL_MS = 5 * 60 * 1000;

async function getAppSecret(): Promise<GitHubAppSecret> {
  const now = Date.now();

  // Check TTL + version before serving from cache
  if (cachedSecret && now - cachedSecret.fetchedAt < SECRET_TTL_MS) {
    // Verify the secret version hasn't rotated
    const versionCheck = await secretsClient.send(
      new GetSecretValueCommand({
        SecretId: config.github.appSecretArn,
        VersionStage: "AWSCURRENT",
      }),
    );
    if (versionCheck.VersionId === cachedSecret.versionId) {
      return cachedSecret.value;
    }
    log("info", "GitHub App secret rotated — refreshing cache");
  }

  const result = await secretsClient.send(
    new GetSecretValueCommand({
      SecretId: config.github.appSecretArn,
    }),
  );

  if (!result.SecretString) {
    throw new Error("GitHub App secret is empty or binary (unexpected)");
  }

  const parsed = JSON.parse(result.SecretString) as GitHubAppSecret;
  cachedSecret = {
    value: parsed,
    fetchedAt: now,
    versionId: result.VersionId ?? "",
  };
  return parsed;
}

/** Create a signed GitHub App JWT (10-minute validity). */
function createAppJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }),
  ).toString("base64url");

  const key = createPrivateKey(privateKeyPem);
  const sign = createSign("RSA-SHA256");
  sign.update(`${header}.${payload}`);
  const sig = sign.sign(key, "base64url");
  return `${header}.${payload}.${sig}`;
}

// Installation token cache: installationId → token + expiry
const installationTokenCache = new Map<
  number,
  { token: string; expiresAt: Date }
>();

/** Get a scoped installation token for the given installation ID. */
export async function getInstallationToken(installationId: number): Promise<InstallationToken> {
  const cached = installationTokenCache.get(installationId);
  if (cached && cached.expiresAt > new Date(Date.now() + 60_000)) {
    // >1 minute left — still valid
    return { token: cached.token, expiresAt: cached.expiresAt.toISOString(), installationId };
  }

  const secret = await getAppSecret();
  const jwt = createAppJwt(secret.appId, secret.privateKey);

  const response = await fetchWithTimeout(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
    config.github.writeTimeoutMs,
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to get installation token for ${installationId}: ${response.status} ${body}`);
  }

  const data = (await response.json()) as { token: string; expires_at: string };
  const expiresAt = new Date(data.expires_at);
  installationTokenCache.set(installationId, { token: data.token, expiresAt });

  return { token: data.token, expiresAt: data.expires_at, installationId };
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
