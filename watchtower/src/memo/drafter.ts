import { randomUUID } from "node:crypto";
import type { Logger } from "../logger.js";
import type { ClientConfig } from "../clients/types.js";
import type { RuleChange } from "../crawlers/types.js";
import type { LlmProvider } from "../classifier/types.js";
import type { MemoRecord } from "./types.js";

// ── Memo drafter ───────────────────────────────────────────────────
//
// One-shot Bedrock Claude call. Produces a 1–2 paragraph impact memo
// that the downstream publisher ultimately ships to Notion or
// Confluence. Memos are stored in `pending_review` — no auto-publish
// unless the client config explicitly enables it (not in v0).
//
// Prompt structure: a short system directive + the rule change + the
// client config + a classifier rationale to focus the analysis. Keep
// the body inside 500 tokens — memos are operator-facing, not policy
// documents; longer output hurts scan-ability.
//

const SYSTEM_PROMPT = [
  "You are a regulatory-change impact memo drafter.",
  "Given a rule change, the affected client, and a classifier rationale,",
  "draft a crisp 1–2 paragraph memo the client's compliance lead will read",
  "to understand what changed and what to do about it.",
  "",
  "Structure:",
  "  Paragraph 1: one sentence on what the regulator did, then one sentence",
  "    on why it matters to THIS client (products / jurisdictions / frameworks).",
  "  Paragraph 2: concrete action items — 2-4 bullet points. Use specific dates,",
  "    docket numbers, and section references from the source when available.",
  "",
  "No preamble, no 'dear reader,' no meta-commentary. Raw memo body in markdown.",
].join("\n");

function buildUserPrompt(change: RuleChange, client: ClientConfig, rationale: string): string {
  return [
    "## Rule Change",
    `Source: ${change.sourceId}`,
    `Title: ${change.title}`,
    `URL: ${change.url}`,
    `Published: ${change.publishedAt}`,
    "",
    "### Summary",
    change.summary || "(no summary)",
    "",
    "### Body",
    (change.body || "").slice(0, 6000),
    "",
    "## Client",
    `Name: ${client.name}`,
    `Products: ${client.products.join(", ")}`,
    `Jurisdictions: ${client.jurisdictions.join(", ")}`,
    `Frameworks: ${client.frameworks.join(", ")}`,
    "",
    "## Classifier rationale",
    rationale,
    "",
    "## Task",
    "Draft the impact memo. Return markdown body only.",
  ].join("\n");
}

export interface MemoDrafterDeps {
  readonly llm: LlmProvider;
  readonly logger: Logger;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

export interface MemoDrafterPort {
  draft(input: {
    readonly change: RuleChange;
    readonly client: ClientConfig;
    readonly rationale: string;
  }): Promise<MemoRecord>;
}

export function createMemoDrafter(deps: MemoDrafterDeps): MemoDrafterPort {
  const { llm, logger, timeoutMs } = deps;
  const now = deps.now ?? (() => new Date());

  return {
    async draft({ change, client, rationale }) {
      const result = await llm.generate({
        system: SYSTEM_PROMPT,
        user: buildUserPrompt(change, client, rationale),
        maxTokens: 800,
        temperature: 0.2,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
      const body = result.text.trim();
      if (!body) {
        logger.error("memo drafter: empty LLM response", {
          clientId: client.clientId,
          ruleChangeId: change.contentHash,
        });
        throw new Error("memo drafter returned empty body");
      }
      const timestamp = now().toISOString();
      return {
        memoId: randomUUID(),
        clientId: client.clientId,
        ruleChangeId: change.contentHash,
        sourceId: change.sourceId,
        status: "pending_review",
        title: `Impact: ${change.title}`,
        body,
        model: llm.modelId,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    },
  };
}
