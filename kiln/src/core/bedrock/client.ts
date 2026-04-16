/**
 * AWS Bedrock Claude client.
 * - IAM role-based auth — no API keys in code or env.
 * - Prompt caching mandatory — system prompt + stable context marked with cachePoint.
 * - Inference logging: NONE (enforced via CDK; verified in CloudTrail at deploy).
 * - Explicit per-call timeout (30s).
 * - Models: Haiku 4.5 for classification, Sonnet 4.6 default, Opus 4.6 for complex synthesis.
 */
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
  type SystemContentBlock,
  type ContentBlock,
} from "@aws-sdk/client-bedrock-runtime";
import { config } from "../../config.js";
import { log } from "../../telemetry/otel.js";
import type {
  ChangelogClassificationRequest,
  ChangelogClassificationResult,
  MigrationSynthesisRequest,
  MigrationSynthesisResult,
  BreakingChange,
  ProposedPatch,
  HumanReviewItem,
} from "../../types.js";

const bedrockClient = new BedrockRuntimeClient({
  region: config.bedrock.region,
  requestHandler: {
    requestTimeout: config.bedrock.timeoutMs,
  },
});

const CLASSIFICATION_SYSTEM: SystemContentBlock[] = [
  {
    text: `You are Kiln's changelog analysis engine. Your job is to identify breaking changes in dependency upgrade changelogs and output structured JSON only — no prose, no markdown fences.

You will receive: the dependency name, version range (fromVersion → toVersion), and a changelog excerpt.

Output EXACTLY this JSON structure:
{
  "hasBreakingChanges": boolean,
  "breakingChanges": [
    {
      "description": "...",
      "category": "api-removal" | "api-rename" | "signature-change" | "behavior-change" | "other",
      "affectedSymbol": "..." | null
    }
  ],
  "changelogUrls": ["..."]
}

Rules:
- Only include items that are genuinely breaking for library consumers.
- Deprecations that still work are NOT breaking changes.
- Internal refactors with no API surface change are NOT breaking changes.
- If nothing is breaking, return hasBreakingChanges: false and empty breakingChanges array.`,
    // Prompt caching — mark stable system prompt for caching
    cachePoint: { type: "default" },
  } as SystemContentBlock & { cachePoint: { type: "default" } },
];

const MIGRATION_SYSTEM: SystemContentBlock[] = [
  {
    text: `You are Kiln's migration synthesis engine. Given a set of breaking changes and specific code usage sites (file paths + line numbers + code content), you produce:
1. Mechanical patches — exact string replacements that fix the breaking change.
2. Human review items — cases where the fix requires business logic judgment.

Output EXACTLY this JSON structure:
{
  "patches": [
    {
      "filePath": "...",
      "lineStart": number,
      "lineEnd": number,
      "originalCode": "...",
      "patchedCode": "...",
      "breakingChangeDescription": "...",
      "confidence": "high" | "medium" | "low"
    }
  ],
  "humanReviewItems": [
    {
      "filePath": "...",
      "line": number,
      "reason": "...",
      "suggestion": "..." | null
    }
  ]
}

Rules:
- Only emit patches where you are certain the replacement is mechanically correct.
- Low-confidence patches should become humanReviewItems instead.
- Never invent patches for usage sites that aren't affected by the listed breaking changes.
- originalCode must be the exact string from the usage site (including surrounding context if needed for uniqueness).`,
    cachePoint: { type: "default" },
  } as SystemContentBlock & { cachePoint: { type: "default" } },
];

/**
 * Classify a changelog excerpt for breaking changes.
 * Uses Claude Haiku 4.5 for cost efficiency on high-volume classification.
 */
export async function classifyChangelog(
  req: ChangelogClassificationRequest,
): Promise<ChangelogClassificationResult> {
  const userMessage = `Dependency: ${req.dep}
Version range: ${req.fromVersion} → ${req.toVersion}

Changelog excerpt:
${req.rawChangelog}`;

  const response = await invokeModel(
    config.bedrock.changelogModel,
    CLASSIFICATION_SYSTEM,
    [{ role: "user", content: [{ text: userMessage }] }],
    "changelog-classification",
  );

  try {
    return JSON.parse(response) as ChangelogClassificationResult;
  } catch {
    log("warn", "Bedrock classification response was not valid JSON", { dep: req.dep });
    return { hasBreakingChanges: false, breakingChanges: [], changelogUrls: [] };
  }
}

/**
 * Synthesize migration patches for specific code usage sites.
 * Uses Claude Sonnet 4.6 by default, escalates to Opus 4.6 for complex changes.
 */
export async function synthesizeMigration(
  req: MigrationSynthesisRequest,
): Promise<MigrationSynthesisResult> {
  const isComplex = req.breakingChanges.length > 5 || req.usageSites.length > 20;
  const model = isComplex ? config.bedrock.complexModel : config.bedrock.migrationModel;

  const userMessage = `Dependency: ${req.dep} ${req.fromVersion} → ${req.toVersion}

Breaking changes:
${req.breakingChanges.map((b, i) => `${i + 1}. [${b.category}] ${b.description}${b.affectedSymbol ? ` (symbol: ${b.affectedSymbol})` : ""}`).join("\n")}

Usage sites in the codebase:
${req.usageSites
  .map(
    (s) => `File: ${s.filePath}
Line: ${s.lineNumber}
Symbol: ${s.symbol}
Code: ${s.lineContent}`,
  )
  .join("\n\n")}`;

  const response = await invokeModel(
    model,
    MIGRATION_SYSTEM,
    [{ role: "user", content: [{ text: userMessage }] }],
    "migration-synthesis",
  );

  try {
    const parsed = JSON.parse(response) as {
      patches: ProposedPatch[];
      humanReviewItems: HumanReviewItem[];
    };
    return parsed;
  } catch {
    log("warn", "Bedrock migration synthesis response was not valid JSON", { dep: req.dep });
    return { patches: [], humanReviewItems: [] };
  }
}

async function invokeModel(
  modelId: string,
  system: SystemContentBlock[],
  messages: Message[],
  operation: string,
): Promise<string> {
  const command = new ConverseCommand({
    modelId,
    system,
    messages,
    inferenceConfig: {
      maxTokens: 4096,
      temperature: 0,
    },
  });

  log("info", "Invoking Bedrock model", { modelId, operation });

  const response = await bedrockClient.send(command);
  const content = response.output?.message?.content ?? [];
  const textBlock = content.find((c): c is ContentBlock.TextMember => "text" in c);

  if (!textBlock) {
    throw new Error(`Bedrock response contained no text block for operation: ${operation}`);
  }

  return textBlock.text;
}
