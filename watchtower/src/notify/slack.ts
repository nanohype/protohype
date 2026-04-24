import type { Logger } from "../logger.js";
import type { Alert } from "./types.js";

// ── Slack webhook adapter ──────────────────────────────────────────
//
// Posts a single Block Kit message to the webhook. Webhooks are the
// simplest per-client delivery target — no OAuth, no per-user tokens.
// Each client's webhook URL lives in `ClientConfig.notifications.slackWebhookUrl`;
// a fallback global URL comes from env.
//

export interface SlackChannelDeps {
  readonly fetchImpl?: typeof fetch;
  readonly logger: Logger;
  readonly timeoutMs?: number;
}

export interface SlackChannel {
  post(webhookUrl: string, alert: Alert): Promise<void>;
}

export function createSlackChannel(deps: SlackChannelDeps): SlackChannel {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const logger = deps.logger;

  return {
    async post(webhookUrl, alert) {
      const res = await fetchImpl(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildSlackPayload(alert)),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        logger.error("slack webhook non-2xx", { status: res.status, body: body.slice(0, 200) });
        throw new Error(`slack HTTP ${res.status}`);
      }
    },
  };
}

function buildSlackPayload(alert: Alert): unknown {
  const headerEmoji = alert.disposition === "alert" ? ":rotating_light:" : ":eyes:";
  const headerText =
    alert.disposition === "alert"
      ? `${headerEmoji} Regulatory change — ${alert.clientName}`
      : `${headerEmoji} Regulatory change needs review — ${alert.clientName}`;

  return {
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: headerText },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${alert.ruleChangeTitle}*\n<${alert.ruleChangeUrl}|Source> • ${alert.sourceId} • score ${alert.score}/100`,
        },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: alert.rationale.slice(0, 2500) },
      },
      ...(alert.publishedPageUrl
        ? [
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: `Memo: <${alert.publishedPageUrl}|open>`,
                },
              ],
            },
          ]
        : []),
    ],
  };
}
