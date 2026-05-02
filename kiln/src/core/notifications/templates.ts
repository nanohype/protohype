// Notification templates. Pure — no Slack SDK, just strings + Block Kit JSON shapes.

import type { PrRef, TeamId } from "../../types.js";

export interface SlackBlock {
  type: string;
  [key: string]: unknown;
}

export function prOpenedBlocks(teamId: TeamId, pr: PrRef, summary: string): SlackBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*kiln* opened <${pr.url}|${pr.owner}/${pr.repo}#${pr.number}> for team \`${teamId}\``,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: summary.slice(0, 2000) },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `_head sha: \`${pr.headSha.slice(0, 7)}\`_` }],
    },
  ];
}

export function failureBlocks(teamId: TeamId, message: string): SlackBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:warning: *kiln* failed for team \`${teamId}\`\n\`\`\`${message.slice(0, 1500)}\`\`\``,
      },
    },
  ];
}
