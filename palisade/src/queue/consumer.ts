import type { SQSClient } from "@aws-sdk/client-sqs";
import { ReceiveMessageCommand, DeleteMessageCommand } from "@aws-sdk/client-sqs";
import type { S3Client } from "@aws-sdk/client-s3";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import type { Logger } from "../logger.js";

export interface ConsumerDeps {
  readonly sqs: SQSClient;
  readonly s3: S3Client;
  readonly queueUrl: string;
  readonly archiveBucket: string;
  readonly logger: Logger;
  readonly pollIntervalMs?: number;
}

/**
 * SQS → S3 archive consumer. Drains the attack-log queue, writes each record
 * to S3 keyed on `{yyyy-mm-dd}/{attempt_id}.json`, and deletes only on
 * successful archive. No DeleteMessage on handler exception — SQS visibility
 * timeout drives retry.
 *
 * Runs in-process; for production deploy as a sidecar or separate Fargate task.
 */
export function createAttackLogConsumer(deps: ConsumerDeps): { start(): void; stop(): Promise<void> } {
  let running = false;
  let inflight: Promise<void> | null = null;

  async function pollOnce(): Promise<void> {
    const result = await deps.sqs.send(
      new ReceiveMessageCommand({ QueueUrl: deps.queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 20 }),
    );
    for (const msg of result.Messages ?? []) {
      if (!msg.Body) continue;
      try {
        const parsed = JSON.parse(msg.Body) as { attemptId?: string; timestamp?: string };
        const date = (parsed.timestamp ?? new Date().toISOString()).slice(0, 10);
        const key = `${date}/${parsed.attemptId ?? msg.MessageId ?? "unknown"}.json`;
        await deps.s3.send(new PutObjectCommand({ Bucket: deps.archiveBucket, Key: key, Body: msg.Body, ContentType: "application/json" }));
        if (msg.ReceiptHandle) {
          await deps.sqs.send(new DeleteMessageCommand({ QueueUrl: deps.queueUrl, ReceiptHandle: msg.ReceiptHandle }));
        }
      } catch (err) {
        deps.logger.error({ err, message_id: msg.MessageId }, "Failed to archive attack log record");
        // Do not delete — visibility timeout will drive retry.
      }
    }
  }

  async function loop(): Promise<void> {
    while (running) {
      try {
        await pollOnce();
      } catch (err) {
        deps.logger.error({ err }, "SQS poll failed");
        await new Promise((r) => setTimeout(r, deps.pollIntervalMs ?? 5_000));
      }
    }
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      inflight = loop();
    },
    async stop(): Promise<void> {
      running = false;
      if (inflight) await inflight;
    },
  };
}
