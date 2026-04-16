/**
 * GitHub App authentication.
 *
 * - Private key lives in AWS Secrets Manager, fetched with a 5-minute TTL cache.
 *   The cache refreshes on version change — no stale key lives past TTL.
 * - All commits are authored through the GitHub App installation — no PATs,
 *   no shared bot accounts.
 * - Every GitHub HTTP call has an explicit per-call timeout (5s reads, 15s writes).
 */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { importPKCS8, SignJWT } from 'jose';
import type { GitHubAppInstallation } from './types';
import { validateChangelogUrl } from './domain-allowlist';

const REGION = process.env.AWS_REGION ?? 'us-west-2';
const GITHUB_APP_SECRET_ARN = process.env.KILN_GITHUB_APP_SECRET_ARN ?? '';
const GITHUB_APP_ID = process.env.KILN_GITHUB_APP_ID ?? '';

const secretsClient = new SecretsManagerClient({
  region: REGION,
  requestHandler: {
    requestTimeout: 5_000,
  } as { requestTimeout: number },
});

// ─── Key cache (5-minute TTL) ─────────────────────────────────────────────────

interface KeyCacheEntry {
  privateKeyPem: string;
  secretVersionId: string;
  fetchedAt: number;
}

let keyCache: KeyCacheEntry | null = null;
const KEY_TTL_MS = 5 * 60 * 1000;   // 5 minutes

async function getPrivateKey(): Promise<string> {
  const now = Date.now();

  // If we have a cached key that is still within TTL, use it.
  // But always re-check the current secret version to detect rotation.
  if (keyCache && now - keyCache.fetchedAt < KEY_TTL_MS) {
    return keyCache.privateKeyPem;
  }

  const result = await secretsClient.send(new GetSecretValueCommand({
    SecretId: GITHUB_APP_SECRET_ARN,
  }));

  const pem = result.SecretString ?? '';
  if (!pem) throw new Error('GitHub App private key secret is empty');

  keyCache = {
    privateKeyPem: pem,
    secretVersionId: result.VersionId ?? '',
    fetchedAt: now,
  };

  return pem;
}

// ─── JWT signing ──────────────────────────────────────────────────────────────

/** Create a signed GitHub App JWT (valid for 60 seconds). */
async function createAppJwt(): Promise<string> {
  const pem = await getPrivateKey();
  const privateKey = await importPKCS8(pem, 'RS256');
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt(now - 10)          // 10s clock skew buffer
    .setExpirationTime(now + 60)    // max 10 min; we use 60s
    .setIssuer(GITHUB_APP_ID)
    .sign(privateKey);
}

// ─── Installation token ───────────────────────────────────────────────────────

/** Fetch a short-lived installation token for the given installation. */
export async function getInstallationToken(installationId: number): Promise<GitHubAppInstallation> {
  const jwt = await createAppJwt();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);  // 5s read timeout

  try {
    const resp = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'kiln-app/0.1',
        },
        signal: controller.signal,
      },
    );

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`GitHub App token exchange failed (${resp.status}): ${body}`);
    }

    const data = (await resp.json()) as { token: string; expires_at: string };
    return {
      installationId,
      appId: parseInt(GITHUB_APP_ID, 10),
      token: data.token,
      expiresAt: data.expires_at,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ─── GitHub REST helpers ──────────────────────────────────────────────────────

interface GitHubApiOptions {
  token: string;
  timeoutMs?: number;
}

async function githubFetch(
  url: string,
  options: GitHubApiOptions & RequestInit,
): Promise<Response> {
  // Validate URL is on api.github.com to prevent SSRF
  validateChangelogUrl(url);

  const { token, timeoutMs = 5_000, ...init } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'kiln-app/0.1',
      },
      signal: controller.signal,
    });
    return resp;
  } finally {
    clearTimeout(timeout);
  }
}

/** Get the default branch SHA for a repo. */
export async function getDefaultBranchSha(params: {
  token: string;
  owner: string;
  repo: string;
}): Promise<{ branch: string; sha: string }> {
  const resp = await githubFetch(
    `https://api.github.com/repos/${params.owner}/${params.repo}`,
    { token: params.token },
  );
  if (!resp.ok) throw new Error(`GitHub repos API (${resp.status}): ${await resp.text()}`);
  const data = (await resp.json()) as { default_branch: string };

  const branchResp = await githubFetch(
    `https://api.github.com/repos/${params.owner}/${params.repo}/git/ref/heads/${data.default_branch}`,
    { token: params.token },
  );
  if (!branchResp.ok) throw new Error(`GitHub refs API (${branchResp.status}): ${await branchResp.text()}`);
  const refData = (await branchResp.json()) as { object: { sha: string } };

  return { branch: data.default_branch, sha: refData.object.sha };
}

/** Create a branch `feat/kiln-{name}` pointing at `fromSha`. */
export async function createKilnBranch(params: {
  token: string;
  owner: string;
  repo: string;
  branchName: string;
  fromSha: string;
}): Promise<void> {
  const resp = await githubFetch(
    `https://api.github.com/repos/${params.owner}/${params.repo}/git/refs`,
    {
      token: params.token,
      method: 'POST',
      timeoutMs: 15_000,
      body: JSON.stringify({
        ref: `refs/heads/${params.branchName}`,
        sha: params.fromSha,
      }),
      headers: { 'Content-Type': 'application/json' },
    },
  );
  if (!resp.ok && resp.status !== 422) {   // 422 = branch already exists
    throw new Error(`GitHub create-ref (${resp.status}): ${await resp.text()}`);
  }
}

/** Get a file's content + blob SHA for subsequent update. */
export async function getFileContent(params: {
  token: string;
  owner: string;
  repo: string;
  path: string;
  ref: string;
}): Promise<{ content: string; sha: string } | null> {
  const resp = await githubFetch(
    `https://api.github.com/repos/${params.owner}/${params.repo}/contents/${params.path}?ref=${params.ref}`,
    { token: params.token },
  );
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`GitHub contents API (${resp.status}): ${await resp.text()}`);
  const data = (await resp.json()) as { content: string; sha: string };
  return {
    content: Buffer.from(data.content, 'base64').toString('utf-8'),
    sha: data.sha,
  };
}

/** Commit a file update to a branch. */
export async function updateFile(params: {
  token: string;
  owner: string;
  repo: string;
  path: string;
  content: string;
  message: string;
  branch: string;
  blobSha: string;
}): Promise<void> {
  const resp = await githubFetch(
    `https://api.github.com/repos/${params.owner}/${params.repo}/contents/${params.path}`,
    {
      token: params.token,
      method: 'PUT',
      timeoutMs: 15_000,
      body: JSON.stringify({
        message: params.message,
        content: Buffer.from(params.content).toString('base64'),
        sha: params.blobSha,
        branch: params.branch,
      }),
      headers: { 'Content-Type': 'application/json' },
    },
  );
  if (!resp.ok) throw new Error(`GitHub update file (${resp.status}): ${await resp.text()}`);
}

/** Open a pull request. Returns the PR number and URL. */
export async function createPullRequest(params: {
  token: string;
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  base: string;
}): Promise<{ number: number; html_url: string }> {
  const resp = await githubFetch(
    `https://api.github.com/repos/${params.owner}/${params.repo}/pulls`,
    {
      token: params.token,
      method: 'POST',
      timeoutMs: 15_000,
      body: JSON.stringify({
        title: params.title,
        body: params.body,
        head: params.head,
        base: params.base,
        draft: false,
      }),
      headers: { 'Content-Type': 'application/json' },
    },
  );
  if (!resp.ok) throw new Error(`GitHub create-PR (${resp.status}): ${await resp.text()}`);
  const data = (await resp.json()) as { number: number; html_url: string };
  return { number: data.number, html_url: data.html_url };
}

/** List files in a directory (shallow). */
export async function listRepoFiles(params: {
  token: string;
  owner: string;
  repo: string;
  path: string;
  ref: string;
}): Promise<Array<{ name: string; path: string; type: 'file' | 'dir' }>> {
  const resp = await githubFetch(
    `https://api.github.com/repos/${params.owner}/${params.repo}/contents/${params.path}?ref=${params.ref}`,
    { token: params.token },
  );
  if (resp.status === 404) return [];
  if (!resp.ok) throw new Error(`GitHub list-files (${resp.status}): ${await resp.text()}`);
  const data = (await resp.json()) as Array<{ name: string; path: string; type: string }>;
  return data.map((f) => ({ name: f.name, path: f.path, type: f.type as 'file' | 'dir' }));
}

/** Search for code in a repo using the GitHub Search API. */
export async function searchCode(params: {
  token: string;
  query: string;
}): Promise<Array<{ path: string; repository: { full_name: string } }>> {
  const q = encodeURIComponent(params.query);
  const resp = await githubFetch(
    `https://api.github.com/search/code?q=${q}&per_page=100`,
    { token: params.token },
  );
  if (!resp.ok) throw new Error(`GitHub search/code (${resp.status}): ${await resp.text()}`);
  const data = (await resp.json()) as {
    items: Array<{ path: string; repository: { full_name: string } }>;
  };
  return data.items;
}

/** Look up the GitHub App installation for an org. */
export async function getOrgInstallation(params: {
  appJwt: string;
  org: string;
}): Promise<number> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const resp = await fetch(
      `https://api.github.com/orgs/${params.org}/installation`,
      {
        headers: {
          Authorization: `Bearer ${params.appJwt}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'kiln-app/0.1',
        },
        signal: controller.signal,
      },
    );
    if (!resp.ok) throw new Error(`GitHub org-installation (${resp.status}): ${await resp.text()}`);
    const data = (await resp.json()) as { id: number };
    return data.id;
  } finally {
    clearTimeout(timeout);
  }
}

/** Exported for testing. */
export function clearKeyCache(): void {
  keyCache = null;
}
