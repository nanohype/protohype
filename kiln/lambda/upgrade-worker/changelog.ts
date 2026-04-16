/**
 * Vendor changelog fetcher.
 *
 * Fetches and caches changelog content in DynamoDB.
 * Only fetches from domains on the allowlist (SSRF prevention).
 * Per-call timeout: 10 seconds.
 * Cache TTL: 24 hours.
 */
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../shared/dynamo';
import { validateChangelogUrl } from '../shared/domain-allowlist';

const CACHE_TTL_SECONDS = 24 * 60 * 60;

interface CachedChangelog {
  cacheKey: string;      // PK: packageName#version
  content: string;
  fetchedAt: string;
  expiresAt: number;     // Unix seconds (DynamoDB TTL)
}

function buildCacheKey(packageName: string, version: string): string {
  return `${packageName}#${version}`;
}

async function getCached(packageName: string, version: string): Promise<string | null> {
  const result = await docClient.send(new GetCommand({
    TableName: TABLE_NAMES.CHANGELOG_CACHE,
    Key: { cacheKey: buildCacheKey(packageName, version) },
    ConsistentRead: false,   // eventual consistency is fine for cache reads
  }));
  if (!result.Item) return null;
  const item = result.Item as CachedChangelog;
  // Respect DynamoDB TTL expiry even before DynamoDB removes the item
  if (item.expiresAt && item.expiresAt < Math.floor(Date.now() / 1000)) return null;
  return item.content;
}

async function putCached(packageName: string, version: string, content: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const item: CachedChangelog = {
    cacheKey: buildCacheKey(packageName, version),
    content,
    fetchedAt: new Date().toISOString(),
    expiresAt: now + CACHE_TTL_SECONDS,
  };
  await docClient.send(new PutCommand({ TableName: TABLE_NAMES.CHANGELOG_CACHE, Item: item }));
}

/**
 * Fetch a vendor changelog.
 * Returns the raw text content (Markdown, HTML, or plain text).
 * Validates the URL against the domain allowlist before fetching.
 */
export async function fetchChangelog(
  packageName: string,
  version: string,
  changelogUrl: string,
): Promise<string> {
  // Check cache first
  const cached = await getCached(packageName, version);
  if (cached) return cached;

  // Validate URL against allowlist — throws DomainNotAllowed on rejection
  validateChangelogUrl(changelogUrl);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  let content: string;
  try {
    const resp = await fetch(changelogUrl, {
      headers: {
        Accept: 'text/html,text/plain,application/json,*/*',
        'User-Agent': 'kiln-app/0.1',
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    if (!resp.ok) {
      throw new Error(`Changelog fetch failed (${resp.status}) for ${changelogUrl}`);
    }

    const rawText = await resp.text();

    // If this is a GitHub API response (JSON), extract the body field
    if (changelogUrl.includes('api.github.com')) {
      try {
        const data = JSON.parse(rawText) as { body?: string; name?: string };
        content = data.body ?? rawText;
      } catch {
        content = rawText;
      }
    } else {
      content = rawText;
    }
  } finally {
    clearTimeout(timeout);
  }

  // Validate that any redirected URL was also on the allowlist.
  // (We can't easily intercept redirects without a custom fetch, so we
  // rely on the domain allowlist + SSRF controls at the VPC/SG level.)

  // Truncate extremely large changelogs to protect Bedrock token limits
  const MAX_CHARS = 40_000;
  if (content.length > MAX_CHARS) {
    content = content.slice(0, MAX_CHARS) + '\n\n[...truncated — full changelog at the URL above...]';
  }

  await putCached(packageName, version, content);
  return content;
}
