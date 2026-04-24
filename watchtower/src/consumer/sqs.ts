import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";
import type { Logger } from "../logger.js";
import type { JobDefinition, QueueProvider } from "./types.js";

// ── SQS queue provider ─────────────────────────────────────────────
//
// Implements the generic QueueProvider over a single SQS queue. The
// worker binds one provider instance per stage queue and hands it to
// `createQueueConsumer`. Receipt handles live in a map keyed on the
// provider's synthetic job id, so the generic QueueDefinition stays
// cloud-agnostic.
//
// `fail()` intentionally does nothing — SQS handles retry via
// visibility timeout + maxReceiveCount on the queue's redrive
// policy. Not calling DeleteMessage leaves the message in-flight;
// it reappears after the visibility timeout expires.
//

export interface SqsQueueProviderDeps {
  readonly sqs: Pick<SQSClient, "send">;
  readonly queueUrl: string;
  readonly jobName: string; // all messages on this queue dispatch under this handler name
  readonly logger: Logger;
  readonly waitTimeSeconds?: number;
  readonly visibilityTimeoutSeconds?: number;
  readonly fifoGroupIdFor?: (data: unknown) => string | undefined;
  readonly fifoDedupIdFor?: (data: unknown) => string | undefined;
}

const DEFAULT_WAIT_TIME_SECONDS = 20;
const DEFAULT_MAX_RECEIVES = 1;

export function createSqsQueueProvider(deps: SqsQueueProviderDeps): QueueProvider {
  const { sqs, queueUrl, jobName, logger } = deps;
  const waitTimeSeconds = deps.waitTimeSeconds ?? DEFAULT_WAIT_TIME_SECONDS;
  const receiptByJobId = new Map<string, string>();

  return {
    name: "sqs",
    async init() {
      // Nothing to do — queue is managed by CDK.
    },
    async enqueue(_jobName, data) {
      const params = {
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(data),
        ...(deps.fifoGroupIdFor ? { MessageGroupId: deps.fifoGroupIdFor(data) } : {}),
        ...(deps.fifoDedupIdFor ? { MessageDeduplicationId: deps.fifoDedupIdFor(data) } : {}),
      };
      const result = await sqs.send(new SendMessageCommand(params));
      return result.MessageId ?? "";
    },
    async dequeue() {
      const result = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: DEFAULT_MAX_RECEIVES,
          WaitTimeSeconds: waitTimeSeconds,
          MessageAttributeNames: ["All"],
          ...(deps.visibilityTimeoutSeconds !== undefined
            ? { VisibilityTimeout: deps.visibilityTimeoutSeconds }
            : {}),
        }),
      );
      const message: Message | undefined = result.Messages?.[0];
      if (!message) return null;
      if (!message.MessageId || !message.ReceiptHandle || !message.Body) {
        logger.warn("sqs message missing required fields", {
          messageId: message.MessageId,
          hasReceipt: Boolean(message.ReceiptHandle),
        });
        return null;
      }
      receiptByJobId.set(message.MessageId, message.ReceiptHandle);
      let data: unknown;
      try {
        data = JSON.parse(message.Body);
      } catch (err) {
        logger.error("sqs message body not JSON — DLQ-bound", {
          messageId: message.MessageId,
          error: err instanceof Error ? err.message : String(err),
        });
        // Surface as a broken job — consumer will call fail() and
        // visibility timeout drives it to DLQ after maxReceiveCount.
        data = { __broken: true, body: message.Body };
      }
      const job: JobDefinition = {
        id: message.MessageId,
        name: jobName,
        data,
        attempts: Number(message.Attributes?.ApproximateReceiveCount ?? 1),
        maxRetries: 3,
        createdAt: new Date(Number(message.Attributes?.SentTimestamp ?? Date.now())).toISOString(),
      };
      return job;
    },
    async acknowledge(jobId) {
      const receipt = receiptByJobId.get(jobId);
      if (!receipt) {
        logger.warn("sqs acknowledge: no receipt for job", { jobId });
        return;
      }
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receipt }));
      receiptByJobId.delete(jobId);
    },
    async fail(jobId, error) {
      // Leave the message in-flight; SQS visibility timeout drives
      // the retry. Drop the receipt to avoid leaking the map.
      receiptByJobId.delete(jobId);
      logger.warn("job failed; SQS will redeliver after visibility timeout", {
        jobId,
        error: error.message,
      });
    },
    async close() {
      receiptByJobId.clear();
    },
  };
}
