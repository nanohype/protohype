import type { SQSClient } from "@aws-sdk/client-sqs";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import type { HoneypotSinkPort, HoneypotRecord, MetricsPort } from "../ports/index.js";
import type { Logger } from "../logger.js";

export interface SqsHoneypotSinkDeps {
  readonly client: SQSClient;
  readonly queueUrl: string;
  readonly metrics: MetricsPort;
  readonly logger: Logger;
}

export function createSqsHoneypotSink(deps: SqsHoneypotSinkDeps): HoneypotSinkPort {
  return {
    async send(record: HoneypotRecord): Promise<void> {
      try {
        await deps.client.send(
          new SendMessageCommand({ QueueUrl: deps.queueUrl, MessageBody: JSON.stringify({ type: "honeypot_hit", ...record }) }),
        );
      } catch (err) {
        deps.logger.warn({ err, attempt_id: record.attemptId }, "Honeypot SQS send failed");
      }
    },
  };
}

/** In-process sink for tests. */
export function createMemorySinks(): {
  attack: { send: (r: unknown) => Promise<void>; received: unknown[] };
  honeypot: { send: (r: unknown) => Promise<void>; received: unknown[] };
} {
  const attackReceived: unknown[] = [];
  const honeypotReceived: unknown[] = [];
  return {
    attack: { send: async (r) => void attackReceived.push(r), received: attackReceived },
    honeypot: { send: async (r) => void honeypotReceived.push(r), received: honeypotReceived },
  };
}
