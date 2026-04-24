import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit as honoBodyLimit } from "hono/body-limit";
import type { NormalizedPrompt, UpstreamShape } from "../types/prompt.js";
import type {
  AttackLogSinkPort,
  AuditLogPort,
  LlmUpstreamPort,
  MetricsPort,
  RateLimiterPort,
  SemanticCachePort,
  TracerPort,
} from "../ports/index.js";
import type { createDetectionPipeline } from "../detect/pipeline.js";
import { type PipelineDeps } from "../detect/pipeline.js";
import { extractIdentity } from "./identity.js";
import { normalize, fullPromptSha256 } from "./normalize.js";
import { rejectBody } from "./error-response.js";
import { createAdminAuth } from "./admin-auth.js";
import { MetricNames } from "../metrics.js";
import { newId, newTraceId } from "../util/hash.js";
import type { Logger } from "../logger.js";
import type { HoneypotHandler } from "../honeypot/types.js";
import type { GateApi } from "../gate/types.js";

export interface AppDeps {
  readonly pipeline: ReturnType<typeof createDetectionPipeline>;
  readonly upstream: LlmUpstreamPort;
  readonly rateLimiter: RateLimiterPort;
  readonly audit: AuditLogPort;
  readonly attackSink: AttackLogSinkPort;
  readonly cache: SemanticCachePort;
  readonly metrics: MetricsPort;
  readonly tracer: TracerPort;
  readonly logger: Logger;
  readonly honeypot: HoneypotHandler;
  readonly gate: GateApi;
  readonly cacheTtlSeconds: number;
  readonly adminApiKey: string | undefined;
  readonly maxBodyBytes: number;
}

export type AppPipelineDeps = PipelineDeps;

/**
 * Build the Hono app. Single source of truth for routes; the wiring file
 * (`src/index.ts`) constructs deps and hands them in.
 */
export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok", service: "palisade" }));

  // Request-size gate runs before every mutating route. 413 response body
  // uses the same opaque shape as detection blocks so a size-probe doesn't
  // learn anything meaningful about the gateway.
  const bodyCap = honoBodyLimit({ maxSize: deps.maxBodyBytes, onError: too_large });
  app.use("/v1/*", bodyCap);
  app.use("/bedrock/*", bodyCap);
  app.use("/honeypot/*", bodyCap);
  app.use("/admin/*", bodyCap);

  // Admin auth guards every mutating /admin/* route. If ADMIN_API_KEY isn't
  // configured (dev default), every admin request rejects — fail-closed.
  const adminAuth = createAdminAuth({ apiKey: deps.adminApiKey });
  app.use("/admin/*", adminAuth);

  app.post("/v1/chat/completions", (c) => handleProxy(c, "openai-chat", deps));
  app.post("/v1/messages", (c) => handleProxy(c, "anthropic-messages", deps));
  app.post("/bedrock/invoke-model", (c) => handleProxy(c, "bedrock-invoke", deps));

  // Honeypot endpoints — same URL shape, different routing.
  app.post("/honeypot/v1/chat/completions", (c) => handleHoneypot(c, "openai-chat", deps));
  app.post("/honeypot/v1/messages", (c) => handleHoneypot(c, "anthropic-messages", deps));
  app.post("/honeypot/bedrock/invoke-model", (c) => handleHoneypot(c, "bedrock-invoke", deps));

  // Label-approval admin routes — proposal, approval, reject.
  app.post("/admin/labels/propose", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      attemptId?: string;
      promptText?: string;
      taxonomy?: string;
      label?: string;
      proposerUserId?: string;
    } | null;
    if (!body?.attemptId || !body?.promptText || !body?.taxonomy || !body?.label || !body?.proposerUserId) {
      return jsonResponse({ code: "BAD_REQUEST", fields: ["attemptId", "promptText", "taxonomy", "label", "proposerUserId"] }, 400);
    }
    const draft = await deps.gate.propose(body as Parameters<GateApi["propose"]>[0]);
    return jsonResponse({ draftId: draft.draftId, status: draft.status }, 200);
  });

  app.post("/admin/labels/:draftId/approve", async (c) => {
    const draftId = c.req.param("draftId");
    const body = (await c.req.json().catch(() => ({}))) as { approverUserId?: string };
    if (!body.approverUserId) return jsonResponse({ code: "BAD_REQUEST", fields: ["approverUserId"] }, 400);
    const result = await deps.gate.approveAndWrite(draftId, body.approverUserId);
    return jsonResponse({ corpusId: result.corpusId, draftId }, 200);
  });

  app.post("/admin/labels/:draftId/reject", async (c) => {
    const draftId = c.req.param("draftId");
    const body = (await c.req.json().catch(() => ({}))) as { rejectorUserId?: string; reason?: string };
    if (!body.rejectorUserId) return jsonResponse({ code: "BAD_REQUEST", fields: ["rejectorUserId"] }, 400);
    await deps.gate.rejectDraft(draftId, body.rejectorUserId, body.reason);
    return jsonResponse({ draftId }, 200);
  });

  return app;
}

// ── Middleware ───────────────────────────────────────────────────────

function too_large(c: Context): Response {
  const traceId = c.req.header("x-request-id") ?? newTraceId();
  return new Response(JSON.stringify(rejectBody(traceId)), {
    status: 413,
    headers: { "content-type": "application/json", "x-request-id": traceId },
  });
}

// ── Request handlers ─────────────────────────────────────────────────

async function handleProxy(c: Context, upstream: UpstreamShape, deps: AppDeps): Promise<Response> {
  const traceId = c.req.header("x-request-id") ?? newTraceId();
  const attemptId = newId("att");
  const rawBody = new Uint8Array(await c.req.arrayBuffer());
  const headers = snapshotHeaders(c.req.raw.headers);
  const remoteIp = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const identity = extractIdentity(headers, remoteIp);

  const prompt: NormalizedPrompt = normalize({ upstream, rawBody, headers, identity, traceId });

  const decision = await deps.rateLimiter.check(identity);
  if (!decision.allowed) {
    return jsonResponse(rejectBody(traceId), 429, {
      "x-request-id": traceId,
      "retry-after": String(Math.ceil((decision.resetAt - Date.now()) / 1000)),
    });
  }

  const cached = await deps.cache.get(prompt.promptHash).catch(() => null);
  if (cached) {
    deps.metrics.counter(MetricNames.SemanticCacheHit, 1, { verdict: cached.outcome });
    if (cached.outcome === "MALICIOUS") {
      return blockResponse(deps, prompt, attemptId, {
        blockingLayer: (cached.blockingLayer as "heuristics" | "classifier" | "corpus-match" | undefined) ?? "corpus-match",
        layerScores: {},
      });
    }
  } else {
    deps.metrics.counter(MetricNames.SemanticCacheMiss, 1);
  }

  const verdict = await deps.pipeline.run(prompt);
  const layerScores = Object.fromEntries(verdict.layers.map((l) => [l.layer, l.score]));

  if (verdict.finalOutcome === "MALICIOUS") {
    await deps.cache
      .set(
        prompt.promptHash,
        { outcome: "MALICIOUS", ...(verdict.blockingLayer ? { blockingLayer: verdict.blockingLayer } : {}) },
        deps.cacheTtlSeconds,
      )
      .catch(() => undefined);
    return blockResponse(deps, prompt, attemptId, {
      blockingLayer: verdict.blockingLayer ?? "heuristics",
      layerScores,
    });
  }

  await deps.cache.set(prompt.promptHash, { outcome: "BENIGN" }, deps.cacheTtlSeconds).catch(() => undefined);
  await deps.audit
    .write(attemptId, "proxy", "DETECTION_ALLOWED", { promptHash: prompt.promptHash, layerScores, upstream })
    .catch((err: unknown) => deps.logger.warn({ err }, "Audit write (ALLOWED) failed"));

  const upstreamStart = Date.now();
  const upstreamResponse = await deps.upstream.forward(prompt).catch(async (err: unknown) => {
    deps.logger.error({ err, attempt_id: attemptId }, "Upstream forward failed");
    await deps.audit
      .write(attemptId, "proxy", "UPSTREAM_FORWARD_FAILED", { upstream, error: err instanceof Error ? err.message : String(err) })
      .catch(() => undefined);
    return null;
  });
  deps.metrics.histogram(MetricNames.UpstreamLatencyMs, Date.now() - upstreamStart, { upstream });

  if (!upstreamResponse) {
    return jsonResponse(rejectBody(traceId), 502, { "x-request-id": traceId });
  }

  // Forward upstream response unchanged. Body is a readable stream or bytes.
  return new Response(upstreamResponse.body as ReadableStream | Uint8Array | null, {
    status: upstreamResponse.status,
    headers: { ...upstreamResponse.headers, "x-request-id": traceId },
  });
}

async function handleHoneypot(c: Context, upstream: UpstreamShape, deps: AppDeps): Promise<Response> {
  const traceId = c.req.header("x-request-id") ?? newTraceId();
  const rawBody = new Uint8Array(await c.req.arrayBuffer());
  const headers = snapshotHeaders(c.req.raw.headers);
  const remoteIp = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const identity = extractIdentity(headers, remoteIp);
  const prompt = normalize({ upstream, rawBody, headers, identity, traceId });
  const result = await deps.honeypot.handle(c.req.path, prompt);
  // Honeypot also escalates the identity's rate-limit so the follow-up real
  // endpoint also gets blocked for a while.
  await deps.rateLimiter.escalate(identity, "hard").catch(() => undefined);
  return jsonResponse(result.body, result.status, { ...result.headers, "x-request-id": traceId });
}

async function blockResponse(
  deps: AppDeps,
  prompt: NormalizedPrompt,
  attemptId: string,
  detail: { blockingLayer: "heuristics" | "classifier" | "corpus-match"; layerScores: Record<string, number> },
): Promise<Response> {
  await Promise.allSettled([
    deps.audit.write(attemptId, "proxy", "DETECTION_BLOCKED", {
      promptHash: prompt.promptHash,
      promptSha256: fullPromptSha256(prompt),
      blockingLayer: detail.blockingLayer,
      layerScores: detail.layerScores,
      upstream: prompt.upstream,
    }),
    deps.attackSink.send({
      attemptId,
      identity: prompt.identity,
      promptSha256: fullPromptSha256(prompt),
      promptText: prompt.text.slice(0, 8_192),
      verdict: "BLOCKED",
      blockingLayer: detail.blockingLayer,
      layerScores: detail.layerScores,
      upstream: prompt.upstream,
      timestamp: new Date().toISOString(),
    }),
    deps.rateLimiter.escalate(prompt.identity, "hard"),
  ]);
  return jsonResponse(rejectBody(prompt.traceId), 400, { "x-request-id": prompt.traceId });
}

function snapshotHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => (out[k.toLowerCase()] = v));
  return out;
}

/**
 * JSON response shim. Hono's `c.json` has a StatusCode-typed argument which
 * trips exactOptionalPropertyTypes + numeric literal inference for extra
 * response codes. We build a `Response` directly, which is a plain WHATWG
 * Response and carries no extra constraints.
 */
function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
