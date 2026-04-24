import type { SQSClient } from "@aws-sdk/client-sqs";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import type { AttackLogSinkPort, AttackLogRecord } from "../ports/index.js";
import type { Logger } from "../logger.js";
import { MetricNames } from "../metrics.js";
import type { MetricsPort } from "../ports/index.js";

export interface SqsAttackSinkDeps {
  readonly client: SQSClient;
  readonly queueUrl: string;
  readonly dlqUrl?: string;
  readonly metrics: MetricsPort;
  readonly logger: Logger;
}

/**
 * At-least-once attack-log fan-out. On SQS send failure, falls through to the
 * DLQ (if configured) and emits a `palisade.attack_log.fanout_failed` metric
 * on total loss. Never throws — palisade's hot path must not stall on async
 * archive failures.
 */
export function createSqsAttackSink(deps: SqsAttackSinkDeps): AttackLogSinkPort {
  return {
    async send(record: AttackLogRecord): Promise<void> {
      try {
        await deps.client.send(new SendMessageCommand({ QueueUrl: deps.queueUrl, MessageBody: JSON.stringify(record) }));
        return;
      } catch (err) {
        deps.logger.warn({ err, attempt_id: record.attemptId }, "Primary SQS send failed, trying DLQ");
      }
      if (deps.dlqUrl) {
        try {
          await deps.client.send(new SendMessageCommand({ QueueUrl: deps.dlqUrl, MessageBody: JSON.stringify(record) }));
          return;
        } catch (err) {
          deps.logger.error({ err, attempt_id: record.attemptId }, "DLQ SQS send failed");
        }
      }
      deps.metrics.counter(MetricNames.AttackLogFanoutFailed, 1, { verdict: record.verdict });
    },
  };
}
