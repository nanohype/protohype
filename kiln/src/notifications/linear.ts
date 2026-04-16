/**
 * Linear issue creation — filed when a breaking change cannot be mechanically patched.
 * Linear API key stored in DynamoDB token store (per-team), not in Secrets Manager.
 */
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { getDocumentClient } from "../db/client.js";
import { config } from "../config.js";
import { log } from "../telemetry/otel.js";
import type { UpgradeRecord, HumanReviewItem } from "../types.js";

interface LinearProject {
  id: string;
}

interface LinearIssue {
  id: string;
  url: string;
}

async function getLinearApiKey(teamId: string): Promise<string | null> {
  const client = getDocumentClient();
  const result = await client.send(
    new GetCommand({
      TableName: config.dynamodb.teamsTable,
      Key: { teamId },
      ProjectionExpression: "linearApiKey",
    }),
  );
  return (result.Item?.["linearApiKey"] as string | null) ?? null;
}

const LINEAR_API = "https://api.linear.app/graphql";

async function linearRequest<T>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const resp = await fetch(LINEAR_API, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!resp.ok) throw new Error(`Linear API returned ${resp.status}`);
    const body = (await resp.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
    if (!body.data) throw new Error("Linear API returned no data");
    return body.data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * File a Linear issue for each human-review item that Kiln could not mechanically patch.
 * Only creates issues when linearProjectId is configured and a human-review item exists.
 */
export async function fileLinearIssues(
  record: UpgradeRecord,
  linearProjectId: string,
): Promise<void> {
  if (record.humanReviewItems.length === 0) return;

  const apiKey = await getLinearApiKey(record.teamId);
  if (!apiKey) {
    log("info", "No Linear API key configured — skipping issue creation", {
      teamId: record.teamId,
    });
    return;
  }

  for (const item of record.humanReviewItems) {
    try {
      await createLinearIssue(apiKey, linearProjectId, record, item);
    } catch (err) {
      log("warn", "Failed to create Linear issue", {
        teamId: record.teamId,
        dep: record.dep,
        err: String(err),
      });
    }
  }
}

async function createLinearIssue(
  apiKey: string,
  projectId: string,
  record: UpgradeRecord,
  item: HumanReviewItem,
): Promise<LinearIssue> {
  const mutation = `
    mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        issue {
          id
          url
        }
      }
    }
  `;

  const title = `kiln: Manual migration needed — ${record.dep} ${record.fromVersion}→${record.toVersion} in ${item.filePath}:${item.line}`;
  const description = `## Kiln: Human Review Required

**Dependency:** \`${record.dep}\` ${record.fromVersion} → ${record.toVersion}
**Repository:** \`${record.owner}/${record.repo}\`
**Kiln PR:** ${record.prUrl ?? "_PR not yet opened_"}

### File Requiring Manual Attention

\`${item.filePath}\` line ${item.line}

**Reason:** ${item.reason}

${item.suggestion ? `**Suggestion:** ${item.suggestion}` : ""}

### Context

Kiln could not automatically patch this usage site. Please review the file, apply the appropriate migration for the breaking change, and close this issue once done.

See the [Kiln PR](${record.prUrl ?? "#"}) for the full Migration Notes.`;

  const result = await linearRequest<{ issueCreate: { issue: LinearIssue } }>(
    apiKey,
    mutation,
    {
      input: {
        title,
        description,
        projectId,
        priority: 2, // High
      },
    },
  );

  log("info", "Linear issue created", {
    teamId: record.teamId,
    issueId: result.issueCreate.issue.id,
    url: result.issueCreate.issue.url,
  });

  return result.issueCreate.issue;
}
