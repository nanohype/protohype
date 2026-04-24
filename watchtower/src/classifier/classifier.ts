import { z } from "zod";
import type { Logger } from "../logger.js";
import type { ClientConfig } from "../clients/types.js";
import type { RuleChange } from "../crawlers/types.js";
import type {
  ClassifierPort,
  ClassifierResult,
  Confidence,
  Disposition,
  LlmProvider,
} from "./types.js";

// ── Applicability classifier ───────────────────────────────────────
//
// Scores a (ruleChange, client) pair on how strongly the change
// affects the client's regulated surface. Fail-secure: any LLM
// error / timeout / malformed output routes the change to
// review (disposition: "review", failureMode: …), never to drop.
// This is the core security invariant of the classifier.
//

const LlmResponseSchema = z.object({
  applicable: z.boolean(),
  score: z.number().int().min(0).max(100),
  confidence: z.enum(["low", "medium", "high"]),
  rationale: z.string().min(1),
});

const SYSTEM_PROMPT = [
  "You are a regulatory-change applicability classifier.",
  "Given a rule change and a client's products/jurisdictions/frameworks,",
  'return a JSON object matching: {"applicable": boolean, "score": 0-100, "confidence": "low"|"medium"|"high", "rationale": string}.',
  "Score 0–100 based on how strongly the change touches the client's regulated surface.",
  "Be conservative: when uncertain whether a change applies, lower the score and the confidence.",
  "Respond with raw JSON only. No markdown, no code fences, no prose before or after.",
].join("\n");

function buildUserPrompt(change: RuleChange, client: ClientConfig): string {
  return [
    "## Rule Change",
    `Source: ${change.sourceId}`,
    `Title: ${change.title}`,
    `Published: ${change.publishedAt}`,
    `URL: ${change.url}`,
    "",
    "### Summary",
    change.summary || "(no summary provided)",
    "",
    "### Body (first 4000 chars)",
    (change.body || "(empty)").slice(0, 4000),
    "",
    "## Client",
    `Name: ${client.name}`,
    `Products: ${client.products.join(", ")}`,
    `Jurisdictions: ${client.jurisdictions.join(", ")}`,
    `Regulatory frameworks: ${client.frameworks.join(", ")}`,
    "",
    "## Task",
    "Does this rule change materially affect the client above?",
    "Return the JSON object as specified in the system prompt.",
  ].join("\n");
}

export interface ClassifierDeps {
  readonly llm: LlmProvider;
  readonly logger: Logger;
  readonly autoAlertThreshold: number; // 0–100
  readonly reviewThreshold: number; // 0–100
  readonly timeoutMs?: number;
}

/**
 * Map numeric score → disposition. Scores ≥ autoAlert route to memo
 * draft; scores ≥ review route to human-review; otherwise drop.
 */
function dispositionFor(
  score: number,
  thresholds: { autoAlert: number; review: number },
): Disposition {
  if (score >= thresholds.autoAlert) return "alert";
  if (score >= thresholds.review) return "review";
  return "drop";
}

export function createClassifier(deps: ClassifierDeps): ClassifierPort {
  const { llm, logger, autoAlertThreshold, reviewThreshold, timeoutMs } = deps;
  if (autoAlertThreshold < reviewThreshold) {
    throw new Error(
      `autoAlertThreshold (${autoAlertThreshold}) must be >= reviewThreshold (${reviewThreshold})`,
    );
  }
  const thresholds = { autoAlert: autoAlertThreshold, review: reviewThreshold };

  function failSecure(
    change: RuleChange,
    client: ClientConfig,
    failureMode: ClassifierResult["failureMode"],
    reason: string,
  ): ClassifierResult {
    // Fail-secure: route to review at the review threshold. Keeps
    // the change visible to humans without broadcasting an alert.
    return {
      sourceId: change.sourceId,
      ruleChangeId: change.contentHash,
      clientId: client.clientId,
      applicable: true,
      score: reviewThreshold,
      confidence: "low",
      rationale: `classifier error: ${reason}. Routed to review by fail-secure default.`,
      disposition: "review",
      model: llm.modelId,
      ...(failureMode ? { failureMode } : {}),
    };
  }

  return {
    async classify({ change, client }) {
      let raw: string;
      try {
        const result = await llm.generate({
          system: SYSTEM_PROMPT,
          user: buildUserPrompt(change, client),
          maxTokens: 1024,
          temperature: 0.1,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        });
        raw = result.text;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const mode: ClassifierResult["failureMode"] = /timeout|aborted/i.test(message)
          ? "timeout"
          : "llm-error";
        logger.error("classifier LLM call failed", {
          clientId: client.clientId,
          ruleChangeId: change.contentHash,
          error: message,
          failureMode: mode,
        });
        return failSecure(change, client, mode, message);
      }

      const extracted = extractJson(raw);
      const parsed = LlmResponseSchema.safeParse(extracted);
      if (!parsed.success) {
        logger.error("classifier LLM response failed schema", {
          clientId: client.clientId,
          ruleChangeId: change.contentHash,
          issues: parsed.error.issues.map((i) => i.path.join(".") + ": " + i.message),
          preview: raw.slice(0, 200),
        });
        return failSecure(change, client, "schema", "response failed schema validation");
      }

      const score = parsed.data.score;
      const disposition = dispositionFor(score, thresholds);
      return {
        sourceId: change.sourceId,
        ruleChangeId: change.contentHash,
        clientId: client.clientId,
        applicable: parsed.data.applicable,
        score,
        confidence: parsed.data.confidence as Confidence,
        rationale: parsed.data.rationale,
        disposition,
        model: llm.modelId,
      };
    },
  };
}

/**
 * Accept JSON that may come back wrapped in markdown fences or with
 * extraneous whitespace. Returns the first JSON object found, or
 * the raw string when none is detectable (Zod will reject it).
 */
function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  // Strip ``` fences if present.
  const fenced = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const candidate = fenced?.[1] ?? trimmed;
  // Find the first {...} block if there's surrounding prose.
  const braceStart = candidate.indexOf("{");
  const braceEnd = candidate.lastIndexOf("}");
  if (braceStart === -1 || braceEnd === -1 || braceEnd < braceStart) {
    return candidate;
  }
  const jsonSlice = candidate.slice(braceStart, braceEnd + 1);
  try {
    return JSON.parse(jsonSlice);
  } catch {
    return candidate;
  }
}
