import type { Logger } from "../logger.js";
import type { Alert } from "./types.js";

// ── Resend email channel ───────────────────────────────────────────
//
// Minimal Resend SDK-free adapter — posts to the Resend REST API via
// fetch. A client's email recipients live in
// `ClientConfig.notifications.emailRecipients`.
//

const RESEND_BASE_URL = "https://api.resend.com";

export interface EmailChannelDeps {
  readonly apiKey: string;
  readonly fromAddress: string;
  readonly fetchImpl?: typeof fetch;
  readonly logger: Logger;
  readonly timeoutMs?: number;
  readonly baseUrl?: string;
}

export interface EmailChannel {
  send(recipients: readonly string[], alert: Alert): Promise<void>;
}

export function createEmailChannel(deps: EmailChannelDeps): EmailChannel {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const baseUrl = deps.baseUrl ?? RESEND_BASE_URL;
  const logger = deps.logger;

  return {
    async send(recipients, alert) {
      if (recipients.length === 0) return;
      const subject =
        alert.disposition === "alert"
          ? `[watchtower] ${alert.clientName}: ${alert.ruleChangeTitle}`
          : `[watchtower review] ${alert.clientName}: ${alert.ruleChangeTitle}`;
      const res = await fetchImpl(`${baseUrl}/emails`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${deps.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: deps.fromAddress,
          to: recipients,
          subject,
          text: buildPlainText(alert),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        logger.error("resend non-2xx", { status: res.status, body: body.slice(0, 200) });
        throw new Error(`resend HTTP ${res.status}`);
      }
    },
  };
}

function buildPlainText(alert: Alert): string {
  return [
    `Rule change: ${alert.ruleChangeTitle}`,
    `Source: ${alert.sourceId}  •  Score: ${alert.score}/100  •  Disposition: ${alert.disposition}`,
    `Link: ${alert.ruleChangeUrl}`,
    "",
    "Rationale:",
    alert.rationale,
    "",
    alert.publishedPageUrl ? `Memo: ${alert.publishedPageUrl}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
