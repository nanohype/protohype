// SQS FIFO upgrade queue. MessageGroupId scoped to (team, repo, pkg) so noisy
// tenants don't serialize unrelated work. MessageDeduplicationId = the
// idempotency digest so retries collapse. W3C trace context is injected into
// MessageAttributes so the worker can continue the trace started by the poller.

import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { idempotencyDigest, messageGroupId } from "../../core/github/idempotency.js";
import type { UpgradeQueuePort } from "../../core/ports.js";
import { injectSqsTraceAttributes } from "../../telemetry/tracing.js";
import { err, ok } from "../../types.js";

export interface SqsAdapterConfig {
  region: string;
  queueUrl: string;
}

export function makeSqsUpgradeQueue(cfg: SqsAdapterConfig): UpgradeQueuePort {
  const client = new SQSClient({ region: cfg.region });

  return {
    async enqueue(job) {
      const key = {
        teamId: job.teamId,
        repo: `${job.repo.owner}/${job.repo.name}`,
        pkg: job.pkg,
        fromVersion: job.fromVersion,
        toVersion: job.toVersion,
      };
      try {
        await client.send(
          new SendMessageCommand({
            QueueUrl: cfg.queueUrl,
            MessageBody: JSON.stringify(job),
            MessageGroupId: messageGroupId(job.teamId, key.repo, job.pkg),
            MessageDeduplicationId: idempotencyDigest(key),
            MessageAttributes: injectSqsTraceAttributes(),
          }),
        );
        return ok(undefined);
      } catch (e) {
        return err({ kind: "Upstream", source: "sqs", message: asMessage(e) });
      }
    },
  };
}

function asMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
