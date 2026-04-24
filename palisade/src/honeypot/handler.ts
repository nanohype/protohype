import type { AuditLogPort, HoneypotSinkPort, MetricsPort, TracerPort } from "../ports/index.js";
import type { NormalizedPrompt } from "../types/prompt.js";
import { fingerprintHit, syntheticRefusal } from "./fingerprint.js";
import { MetricNames } from "../metrics.js";
import { newId } from "../util/hash.js";
import type { Logger } from "../logger.js";

export interface HoneypotHandlerDeps {
  readonly audit: AuditLogPort;
  readonly sink: HoneypotSinkPort;
  readonly metrics: MetricsPort;
  readonly tracer: TracerPort;
  readonly logger: Logger;
  /** Simulated upstream latency — real gateway p50 + jitter. */
  readonly latencyJitterMs: { readonly min: number; readonly max: number };
}

export interface HoneypotResult {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Record<string, string>;
  readonly attemptId: string;
}

/**
 * Honeypot handler — looks like a real LLM endpoint, responds with a
 * synthetic refusal. Never forwards. Fingerprints + audits every hit.
 */
export function createHoneypotHandler(deps: HoneypotHandlerDeps) {
  async function handle(endpoint: string, prompt: NormalizedPrompt): Promise<HoneypotResult> {
    return deps.tracer.withSpan(
      "palisade.honeypot.hit",
      { "palisade.endpoint": endpoint, "palisade.prompt_hash": prompt.promptHash },
      async (_span) => {
        const attemptId = newId("hp");
        const fp = fingerprintHit(prompt.headers, prompt.rawBody.byteLength);
        const refusal = syntheticRefusal(prompt.promptHash);

        // Simulated latency — matches real proxy p50 + jitter so timing side-
        // channels can't distinguish honeypot from real.
        const latency =
          deps.latencyJitterMs.min + Math.floor(Math.random() * Math.max(1, deps.latencyJitterMs.max - deps.latencyJitterMs.min));
        await new Promise((r) => setTimeout(r, latency));

        const record = {
          attemptId,
          endpoint,
          identity: prompt.identity,
          fingerprint: fp,
          promptText: prompt.text.slice(0, 4_096),
          bodyLength: prompt.rawBody.byteLength,
          timestamp: new Date().toISOString(),
        };

        await Promise.allSettled([
          deps.sink.send(record),
          deps.audit.write(attemptId, "honeypot", "HONEYPOT_HIT", {
            promptHash: prompt.promptHash,
            endpoint,
            fingerprint: fp,
            bodyLength: prompt.rawBody.byteLength,
          }),
        ]);

        deps.metrics.counter(MetricNames.HoneypotHit, 1, { endpoint });
        deps.logger.info({ attempt_id: attemptId, endpoint, fingerprint: fp }, "Honeypot hit");

        return {
          status: 200,
          body: buildRefusalBody(endpoint, refusal),
          headers: { "content-type": "application/json", "x-request-id": prompt.traceId },
          attemptId,
        };
      },
    );
  }
  return { handle };
}

function buildRefusalBody(endpoint: string, refusal: string): unknown {
  // Shape the refusal to match the upstream the endpoint impersonates so a
  // naive attacker client can't distinguish by shape either.
  if (endpoint.includes("openai") || endpoint.includes("v1/chat/completions")) {
    return {
      id: `chatcmpl-${Math.random().toString(36).slice(2, 10)}`,
      object: "chat.completion",
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: refusal }, finish_reason: "stop" }],
    };
  }
  if (endpoint.includes("anthropic") || endpoint.includes("v1/messages")) {
    return {
      id: `msg_${Math.random().toString(36).slice(2, 10)}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: refusal }],
      model: "claude-sonnet-4-6",
      stop_reason: "end_turn",
    };
  }
  return { output: refusal };
}
