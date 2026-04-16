import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { awsRegion } from './aws.js';

export interface DlqMessage {
  correlationId: string;
  stage: string;
  source?: string;
  sourceItemId?: string;
  error: string;
  timestamp?: string;
}

export interface DlqClient {
  sendMessage(m: DlqMessage): Promise<void>;
}

/** Tiny port over SQS — only the `send` shape we use. */
export interface SqsPort {
  send(command: SendMessageCommand): Promise<unknown>;
}

export interface CreateDlqDeps {
  sqs?: SqsPort;
  dlqUrl?: string | undefined;
  /** Logger for the no-DLQ fallback path. Defaults to console.error;
   *  tests inject a `vi.fn` and assert on the JSON shape. */
  logger?: (line: string) => void;
  /** Clock for the timestamp default. */
  now?: () => Date;
}

function defaultSqs(): SqsPort {
  return new SQSClient({ region: awsRegion() });
}

export function createDlqClient(deps: CreateDlqDeps = {}): DlqClient {
  const sqs = deps.sqs ?? defaultSqs();
  const dlqUrl = 'dlqUrl' in deps ? deps.dlqUrl : process.env['DLQ_URL'];
  const log = deps.logger ?? ((line) => console.error(line));
  const now = deps.now ?? (() => new Date());

  if (!dlqUrl) {
    return {
      async sendMessage(m) {
        log(JSON.stringify({ ...m, _dlq: true }));
      },
    };
  }
  return {
    async sendMessage(m) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: dlqUrl,
          MessageBody: JSON.stringify({
            ...m,
            timestamp: m.timestamp ?? now().toISOString(),
          }),
        }),
      );
    },
  };
}

let _default: DlqClient | undefined;
export function getDlqClient(): DlqClient {
  if (!_default) _default = createDlqClient();
  return _default;
}
