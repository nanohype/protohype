import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';

export interface BreakingChangeHint {
  description: string;
  /** Regex pattern to locate affected call sites in TypeScript/JS source. */
  apiPattern: string;
  /** Optional replacement pattern (uses $1, $2 capture groups). */
  suggestedPatch?: string;
  requiresHumanReview: boolean;
}

export interface ChangeAnalysis {
  breakingChanges: BreakingChangeHint[];
  summary: string;
}

/**
 * System prompt is stable — eligible for Bedrock prompt caching.
 */
const SYSTEM_PROMPT = `You are a TypeScript/JavaScript migration expert.
Analyze dependency changelogs and identify breaking changes that require code modifications.
Return JSON only. No markdown fences, no prose outside JSON.`;

/**
 * Classify breaking changes in a changelog using Claude Haiku (fast/cheap).
 * Uses prompt caching on the system prompt for cache-hit savings.
 *
 * @param changelog   Raw changelog text (truncated to 50 kB internally).
 * @param depName     Dependency name, e.g. "@aws-sdk/client-s3".
 * @param fromVersion Source semver, e.g. "2.1.0".
 * @param toVersion   Target semver, e.g. "3.0.0".
 * @param client      Pre-configured BedrockRuntimeClient (IAM role auth).
 */
export async function analyzeChangelog(
  changelog: string,
  depName: string,
  fromVersion: string,
  toVersion: string,
  client: BedrockRuntimeClient,
): Promise<ChangeAnalysis> {
  const truncated = changelog.slice(0, 50_000);

  const userContent = `Analyze the changelog for ${depName} upgrading from ${fromVersion} to ${toVersion}.

CHANGELOG:
${truncated}

Return JSON with this exact shape:
{
  "breakingChanges": [
    {
      "description": "string",
      "apiPattern": "regex or code pattern that identifies affected call sites",
      "suggestedPatch": "optional — replacement pattern using $1 $2 capture groups",
      "requiresHumanReview": boolean
    }
  ],
  "summary": "one-line summary of the upgrade"
}`;

  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 4096,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: userContent }],
  });

  const command = new InvokeModelCommand({
    // Haiku for classification — fast and cost-efficient
    modelId: 'anthropic.claude-haiku-4-5',
    body: Buffer.from(body),
    contentType: 'application/json',
    accept: 'application/json',
  });

  const response = await client.send(command);
  const responseBody = JSON.parse(
    new TextDecoder().decode(response.body),
  ) as { content?: Array<{ type: string; text: string }> };

  const text = responseBody.content?.[0]?.text ?? '{}';

  try {
    return JSON.parse(text) as ChangeAnalysis;
  } catch {
    return { breakingChanges: [], summary: 'Failed to parse analysis response' };
  }
}

/**
 * Classify changelog complexity using Sonnet when Haiku's output is ambiguous.
 * Escalation path only — do not call by default.
 */
export async function escalateAnalysis(
  changelog: string,
  depName: string,
  fromVersion: string,
  toVersion: string,
  client: BedrockRuntimeClient,
): Promise<ChangeAnalysis> {
  // Sonnet for complex migration synthesis
  const truncated = changelog.slice(0, 100_000);

  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 8192,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: `Perform a deep migration analysis for ${depName} ${fromVersion} → ${toVersion}.\n\nCHANGELOG:\n${truncated}\n\nReturn the same JSON shape as before.`,
      },
    ],
  });

  const command = new InvokeModelCommand({
    modelId: 'anthropic.claude-sonnet-4-6',
    body: Buffer.from(body),
    contentType: 'application/json',
    accept: 'application/json',
  });

  const response = await client.send(command);
  const responseBody = JSON.parse(
    new TextDecoder().decode(response.body),
  ) as { content?: Array<{ type: string; text: string }> };

  const text = responseBody.content?.[0]?.text ?? '{}';

  try {
    return JSON.parse(text) as ChangeAnalysis;
  } catch {
    return { breakingChanges: [], summary: 'Escalation analysis failed to parse' };
  }
}
