/**
 * Heuristic pattern library. Each pattern is a named predicate that scores
 * the prompt on a 0..1 scale. The layer aggregates scores via the caller-
 * supplied aggregator. All patterns operate on raw text — no parsing.
 *
 * Patterns are separated from the runner so new rules can be added without
 * touching the dispatch logic and so the catalog is grep-auditable.
 */

export type PatternId =
  | "role-reassignment"
  | "delimiter-injection"
  | "base64-payload"
  | "hex-payload"
  | "unicode-homoglyph"
  | "jailbreak-persona"
  | "data-exfiltration"
  | "indirect-injection-markers";

export interface PatternHit {
  readonly id: PatternId;
  /** 0..1 — strength of the match. 1 is a ceiling signal. */
  readonly score: number;
  /** 32 chars max for audit — original substring slice. */
  readonly excerpt?: string;
}

export interface PatternConfig {
  readonly base64MinBytes: number;
}

// ── Patterns ─────────────────────────────────────────────────────────

const ROLE_REASSIGNMENT = [
  /\bignore\s+(all\s+)?(previous|prior|above|the\s+above)\s+(instructions?|prompts?|rules?)\b/i,
  /\byou\s+are\s+(now|actually)\s+[A-Z]/i,
  /\bfrom\s+now\s+on\s+you\s+(are|will\s+act)\b/i,
  /\b(?:system|assistant)\s*:\s*(?:you\s+are|act\s+as)/i,
  /\bdisregard\s+(all\s+)?(your|the)\s+(previous|prior|above|initial)\s+(instructions?|programming)\b/i,
];

const DELIMITER_INJECTION = [
  /\[\[\s*(?:begin|end|system|instructions?|prompt)\s*(?:system)?\s*\]\]/i,
  /###\s*(?:new|system|override|begin)\s+(?:instructions?|prompt|rules?)/i,
  /<\|im_start\|>|<\|im_end\|>|<\|system\|>|<\|assistant\|>/,
  /<\/?\s*(?:system|assistant|instructions?)\s*>/i,
  /<\/s>\s*<s>/,
  /```+\s*system\s*\n/i,
];

const JAILBREAK_PERSONAS = [
  /\b(DAN|do\s+anything\s+now|developer\s+mode|godmode|AIM\s+mode|evil\s+dan)\b/i,
  /\bpretend\s+you\s+(are|have)\s+no\s+(restrictions?|rules?|guidelines?)\b/i,
  /\bmy\s+(dead\s+)?grandma\s+used\s+to\s+(tell|read|sing)\b/i,
  /\bhypothetically,?\s+if\s+you\s+had\s+no\s+(rules?|filters?|restrictions?)\b/i,
];

const DATA_EXFILTRATION = [
  /\b(reveal|print|output|show|display|repeat)\s+(your|the|all)\s+(system\s+prompt|instructions?|initial\s+prompt|rules)\b/i,
  /\brepeat\s+the\s+words?\s+above\s+starting\s+with/i,
  /\bwhat\s+(are|were)\s+your\s+(initial|original)\s+instructions?\b/i,
  /\byour\s+prompt\s+verbatim\b/i,
];

const INDIRECT_MARKERS = [
  /\[BEGIN DOCUMENT\][\s\S]*?\[END DOCUMENT\]/i,
  /<retrieved>[\s\S]*?<\/retrieved>/i,
  /\n\s*---\s*\n\s*(?:instructions?|system):/i,
];

// ── Detectors ────────────────────────────────────────────────────────

export function detectPatterns(text: string, cfg: PatternConfig): PatternHit[] {
  const hits: PatternHit[] = [];

  for (const re of ROLE_REASSIGNMENT) {
    const m = re.exec(text);
    if (m) hits.push({ id: "role-reassignment", score: 0.95, excerpt: m[0].slice(0, 32) });
  }
  for (const re of DELIMITER_INJECTION) {
    const m = re.exec(text);
    if (m) hits.push({ id: "delimiter-injection", score: 0.9, excerpt: m[0].slice(0, 32) });
  }
  for (const re of JAILBREAK_PERSONAS) {
    const m = re.exec(text);
    if (m) hits.push({ id: "jailbreak-persona", score: 0.9, excerpt: m[0].slice(0, 32) });
  }
  for (const re of DATA_EXFILTRATION) {
    const m = re.exec(text);
    if (m) hits.push({ id: "data-exfiltration", score: 0.92, excerpt: m[0].slice(0, 32) });
  }
  for (const re of INDIRECT_MARKERS) {
    const m = re.exec(text);
    if (m) hits.push({ id: "indirect-injection-markers", score: 0.6, excerpt: m[0].slice(0, 32) });
  }

  const base64 = findLongBase64(text, cfg.base64MinBytes);
  if (base64) hits.push({ id: "base64-payload", score: 0.7, excerpt: base64.slice(0, 32) });

  const hex = findLongHex(text, cfg.base64MinBytes);
  if (hex) hits.push({ id: "hex-payload", score: 0.55, excerpt: hex.slice(0, 32) });

  if (hasHomoglyphs(text)) hits.push({ id: "unicode-homoglyph", score: 0.5 });

  return hits;
}

// ── Encoded-payload detectors ────────────────────────────────────────

const BASE64_RUN_RE = /[A-Za-z0-9+/]{40,}={0,2}/g;

function findLongBase64(text: string, minBytes: number): string | null {
  const threshold = Math.max(minBytes, 40);
  let match: RegExpExecArray | null;
  // Reset lastIndex each call — stateful global regex.
  BASE64_RUN_RE.lastIndex = 0;
  while ((match = BASE64_RUN_RE.exec(text)) !== null) {
    const candidate = match[0];
    if (candidate.length < threshold) continue;
    if (looksLikeBase64(candidate)) return candidate;
  }
  return null;
}

function looksLikeBase64(candidate: string): boolean {
  // Heuristic: alphabet-entropy check — penalise long all-lowercase runs
  // (human english text) while accepting dense mixed-case/digit runs.
  const upper = (candidate.match(/[A-Z]/g) ?? []).length;
  const lower = (candidate.match(/[a-z]/g) ?? []).length;
  const digits = (candidate.match(/[0-9]/g) ?? []).length;
  const total = candidate.length;
  const hasMixedAlphabet = upper > 0 && lower > 0;
  const hasDensity = (upper + digits) / total > 0.15;
  return hasMixedAlphabet && hasDensity;
}

const HEX_RUN_RE = /\b[0-9a-fA-F]{64,}\b/g;

function findLongHex(text: string, minBytes: number): string | null {
  HEX_RUN_RE.lastIndex = 0;
  const threshold = Math.max(minBytes, 64);
  let match: RegExpExecArray | null;
  while ((match = HEX_RUN_RE.exec(text)) !== null) {
    if (match[0].length >= threshold) return match[0];
  }
  return null;
}

// ── Unicode homoglyphs ───────────────────────────────────────────────

// Cyrillic look-alikes for Latin letters commonly used in role-reassignment
// payloads (e.g. "іgnore previous" with Cyrillic "і"). Cheap enough to
// sniff; real analysis would use the Unicode Confusables table.
const HOMOGLYPH_RE = /[\u0400-\u04FF\u0500-\u052F\u2000-\u206F]/u;

function hasHomoglyphs(text: string): boolean {
  return HOMOGLYPH_RE.test(text);
}
