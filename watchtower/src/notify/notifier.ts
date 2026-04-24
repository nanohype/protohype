import { randomUUID } from "node:crypto";
import type { Logger } from "../logger.js";
import type { AuditPort } from "../audit/types.js";
import type { ClientConfig } from "../clients/types.js";
import type { EmailChannel } from "./email.js";
import type { SlackChannel } from "./slack.js";
import type { Alert, AlertChannelResult, NotifierPort } from "./types.js";

// ── Multichannel notifier ──────────────────────────────────────────
//
// Dispatches an alert to every channel configured on the client.
// Failures on one channel don't block the others — email going down
// shouldn't prevent the Slack alert. Audit emits one ALERT_SENT event
// per successful channel for compliance visibility.
//

export interface NotifierDeps {
  readonly slack?: SlackChannel;
  readonly email?: EmailChannel;
  readonly audit: AuditPort;
  readonly client: ClientConfig;
  readonly fallbackSlackWebhookUrl?: string;
  readonly logger: Logger;
  readonly now?: () => Date;
}

export function createNotifier(deps: NotifierDeps): NotifierPort {
  const { slack, email, audit, client, fallbackSlackWebhookUrl, logger } = deps;
  const now = deps.now ?? (() => new Date());

  return {
    async send(alert: Alert): Promise<readonly AlertChannelResult[]> {
      const results: AlertChannelResult[] = [];

      const slackUrl = client.notifications?.slackWebhookUrl ?? fallbackSlackWebhookUrl;
      if (slack && slackUrl) {
        results.push(await dispatch("slack", slackUrl, () => slack.post(slackUrl, alert)));
      }

      const emailRecipients = client.notifications?.emailRecipients ?? [];
      if (email && emailRecipients.length > 0) {
        results.push(
          await dispatch("email", emailRecipients.join(","), () =>
            email.send(emailRecipients, alert),
          ),
        );
      }

      for (const r of results) {
        if (!r.success) continue;
        try {
          await audit.emit({
            type: "ALERT_SENT",
            eventId: randomUUID(),
            timestamp: now().toISOString(),
            clientId: alert.clientId,
            channel: r.channel,
            recipient: r.recipient,
            ...(alert.memoId ? { memoId: alert.memoId } : {}),
          });
        } catch (err) {
          // Don't fail notification dispatch on audit hiccup — but log loudly.
          logger.error("audit emit failed for ALERT_SENT", {
            clientId: alert.clientId,
            channel: r.channel,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return results;
    },
  };

  async function dispatch(
    channel: "slack" | "email",
    recipient: string,
    run: () => Promise<void>,
  ): Promise<AlertChannelResult> {
    try {
      await run();
      return { channel, recipient, success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("notifier channel failed", {
        channel,
        recipient,
        error: message,
      });
      return { channel, recipient, success: false, error: message };
    }
  }
}
