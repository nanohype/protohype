/**
 * Slack notifications — per-team channel from team config.
 * Team Slack tokens stored in DynamoDB token store (one item per team), NOT in Secrets Manager.
 * This scales past 50 teams without one-secret-per-team cost explosion.
 */
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { getDocumentClient } from "../db/client.js";
import { config } from "../config.js";
import { log } from "../telemetry/otel.js";
import type { UpgradeRecord } from "../types.js";

interface TeamTokens {
  teamId: string;
  slackBotToken: string | null;
  linearApiKey: string | null;
}

const tokenCache = new Map<string, { tokens: TeamTokens; fetchedAt: number }>();
const TOKEN_TTL_MS = 5 * 60 * 1000;

async function getTeamTokens(teamId: string): Promise<TeamTokens> {
  const cached = tokenCache.get(teamId);
  if (cached && Date.now() - cached.fetchedAt < TOKEN_TTL_MS) {
    return cached.tokens;
  }

  const client = getDocumentClient();
  const result = await client.send(
    new GetCommand({
      TableName: config.dynamodb.teamsTable,
      Key: { teamId },
      ProjectionExpression: "teamId, slackBotToken, linearApiKey",
    }),
  );

  const tokens: TeamTokens = {
    teamId,
    slackBotToken: result.Item?.["slackBotToken"] as string | null ?? null,
    linearApiKey: result.Item?.["linearApiKey"] as string | null ?? null,
  };

  tokenCache.set(teamId, { tokens, fetchedAt: Date.now() });
  return tokens;
}

/** Send a Slack notification when a Kiln PR is opened. */
export async function notifyPROpened(
  record: UpgradeRecord,
  slackChannel: string,
): Promise<void> {
  const tokens = await getTeamTokens(record.teamId);
  if (!tokens.slackBotToken) {
    log("info", "No Slack token configured for team — skipping notification", {
      teamId: record.teamId,
    });
    return;
  }

  const humanCount = record.humanReviewItems.length;
  const patchCount = record.patchedFiles.length;
  const breakingCount = record.breakingChanges.length;

  const urgencyEmoji = humanCount > 0 ? "⚠️" : breakingCount > 0 ? "🔧" : "✅";

  const message = {
    channel: slackChannel,
    text: `${urgencyEmoji} Kiln opened a PR: \`${record.dep}\` ${record.fromVersion} → ${record.toVersion} in \`${record.owner}/${record.repo}\``,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `${urgencyEmoji} Kiln Upgrade PR — ${record.dep} ${record.fromVersion} → ${record.toVersion}`,
        },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Repo:*\n\`${record.owner}/${record.repo}\`` },
          { type: "mrkdwn", text: `*PR:*\n<${record.prUrl}|View PR #${record.prNumber}>` },
          { type: "mrkdwn", text: `*Breaking changes:*\n${breakingCount}` },
          { type: "mrkdwn", text: `*Patches applied:*\n${patchCount}` },
          ...(humanCount > 0
            ? [{ type: "mrkdwn", text: `*⚠️ Human review needed:*\n${humanCount} items` }]
            : []),
        ],
      },
    ],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const resp = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${tokens.slackBotToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(message),
    });

    const body = (await resp.json()) as { ok: boolean; error?: string };
    if (!body.ok) {
      log("warn", "Slack notification failed", { error: body.error, teamId: record.teamId });
    }
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      log("warn", "Slack notification timed out", { teamId: record.teamId });
    } else {
      log("warn", "Slack notification error", { err: String(err), teamId: record.teamId });
    }
  } finally {
    clearTimeout(timer);
  }
}
