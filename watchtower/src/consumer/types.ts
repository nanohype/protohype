// ── Queue Consumer Types ────────────────────────────────────────────
//
// Generic types for watchtower's stage-handoff consumers. Each SQS
// queue (crawl / classify / publish / audit) has its own consumer
// instance wired in src/index.ts. `JobDefinition<T>` is the envelope
// every stage receives; handlers validate the `data` payload with Zod
// at the boundary (see src/handlers/*).
//

/** A unit of work dequeued from a queue provider. */
export interface JobDefinition<T = unknown> {
  /** Unique identifier assigned by the provider (SQS message id). */
  id: string;

  /** Logical job name used to route to the correct handler. */
  name: string;

  /** Arbitrary payload carried by the job. Validated by the handler. */
  data: T;

  /** Number of times this job has been attempted so far. */
  attempts: number;

  /** Maximum number of retries before the job is marked as failed. */
  maxRetries: number;

  /** ISO-8601 timestamp of when the job was enqueued. */
  createdAt: string;
}

/** Pluggable queue provider interface for enqueue/dequeue operations. */
export interface QueueProvider {
  /** Unique provider name (e.g. "memory", "sqs"). */
  readonly name: string;

  /** Initialize the provider with configuration. */
  init(config: Record<string, unknown>): Promise<void>;

  /** Enqueue a job for processing. Returns the assigned job ID. */
  enqueue(jobName: string, data: unknown): Promise<string>;

  /** Dequeue the next available job, or null if the queue is empty. */
  dequeue(): Promise<JobDefinition | null>;

  /** Acknowledge successful processing of a job. */
  acknowledge(jobId: string): Promise<void>;

  /** Mark a job as failed with the given error. */
  fail(jobId: string, error: Error): Promise<void>;

  /** Gracefully shut down the provider, releasing connections. */
  close(): Promise<void>;
}

/** Function that processes a single dequeued job. */
export type JobHandler<T = unknown> = (job: JobDefinition<T>) => Promise<void>;

/** Map of job names to their handler functions. */
export type HandlerMap = Record<string, JobHandler>;
