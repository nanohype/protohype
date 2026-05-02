// Slack notifications via incoming webhook. For now we do webhook-style
// POSTs; if we later need DMs, buttons, or threading, swap to @slack/web-api.

import { failureBlocks, prOpenedBlocks } from "../../core/notifications/templates.js";
import type { NotificationsPort } from "../../core/ports.js";
import { err, ok } from "../../types.js";

export interface SlackAdapterConfig {
  webhookUrl: string | undefined;
  timeoutMs: number;
}

export function makeSlackNotificationsAdapter(cfg: SlackAdapterConfig): NotificationsPort {
  const post = async (blocks: unknown[]): Promise<void> => {
    if (!cfg.webhookUrl) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const resp = await fetch(cfg.webhookUrl, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ blocks }),
      });
      if (!resp.ok) throw new Error(`slack ${resp.status} ${resp.statusText}`);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async postPrOpened(_channel, teamId, pr, summary) {
      try {
        await post(prOpenedBlocks(teamId, pr, summary));
        return ok(undefined);
      } catch (e) {
        return err({ kind: "Upstream", source: "slack", message: asMessage(e) });
      }
    },
    async postFailure(_channel, teamId, message) {
      try {
        await post(failureBlocks(teamId, message));
        return ok(undefined);
      } catch (e) {
        return err({ kind: "Upstream", source: "slack", message: asMessage(e) });
      }
    },
  };
}

function asMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
