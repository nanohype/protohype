// Guardrails — validate + normalize LLM output before it touches domain state.

import { z } from "zod";
import type { ClassifyOutput, SynthesizeOutput } from "../ports.js";

const breakingChangeSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  severity: z.enum(["breaking", "deprecation", "behavior-change"]),
  description: z.string().min(1),
  affectedSymbols: z.array(z.string()),
  changelogUrl: z.string().url(),
});

const classifyOutputSchema = z.object({
  breakingChanges: z.array(breakingChangeSchema),
  summary: z.string(),
  confidence: z.number().min(0).max(1),
});

const filePatchSchema = z.object({
  path: z.string().min(1),
  before: z.string(),
  after: z.string(),
  citations: z.array(z.string()),
});

const synthesizeOutputSchema = z.object({
  patches: z.array(filePatchSchema),
  notes: z.string(),
  warnings: z.array(z.string()),
});

export function parseClassifyOutput(raw: string): ClassifyOutput {
  const parsed: unknown = JSON.parse(stripFences(raw));
  return classifyOutputSchema.parse(parsed);
}

export function parseSynthesizeOutput(raw: string): SynthesizeOutput {
  const parsed: unknown = JSON.parse(stripFences(raw));
  return synthesizeOutputSchema.parse(parsed);
}

// Claude sometimes wraps JSON in ```json fences despite the prompt saying not to.
function stripFences(s: string): string {
  const trimmed = s.trim();
  if (trimmed.startsWith("```")) {
    const firstNewline = trimmed.indexOf("\n");
    const end = trimmed.lastIndexOf("```");
    if (firstNewline !== -1 && end > firstNewline) {
      return trimmed.slice(firstNewline + 1, end).trim();
    }
  }
  return trimmed;
}
