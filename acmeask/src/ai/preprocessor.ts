/**
 * Query preprocessor — sanitizes input, detects PII, blocks prompt injection.
 */
import type { PreprocessResult } from '../types';

const MAX_QUESTION_CHARS = 512;

// Prompt injection patterns (case-insensitive)
const INJECTION_HIGH_RISK = [
  /ignore\s+(previous|all|prior)\s+instructions/i,
  /forget\s+your\s+instructions/i,
  /system\s*:/i,
  /you\s+are\s+now/i,
  /act\s+as\s+if\s+you\s+are/i,
  /DAN\s+mode/i,
  /jailbreak/i,
];

const INJECTION_LOW_RISK = [
  /disregard/i,
  /override/i,
  /prompt\s+injection/i,
];

// PII patterns
const PII_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'email', pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  { name: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  { name: 'phone', pattern: /\b(\+1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g },
  { name: 'credit_card', pattern: /\b(?:\d{4}[\s-]?){3}\d{4}\b/g },
  { name: 'aws_access_key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'aws_secret_key', pattern: /\b[a-zA-Z0-9/+=]{40}\b/g },
];

export function preprocessQuery(rawText: string): PreprocessResult {
  // 1. Truncate
  let text = rawText.slice(0, MAX_QUESTION_CHARS);

  // 2. Strip HTML/markdown that could inject structure
  text = text.replace(/<[^>]+>/g, ' ').replace(/```[\s\S]*?```/g, '[code block]');

  // 3. Prompt injection detection
  let injectionRisk: PreprocessResult['injectionRisk'] = 'none';
  for (const pattern of INJECTION_HIGH_RISK) {
    if (pattern.test(text)) {
      injectionRisk = 'high';
      break;
    }
  }
  if (injectionRisk === 'none') {
    for (const pattern of INJECTION_LOW_RISK) {
      if (pattern.test(text)) {
        injectionRisk = 'low';
        break;
      }
    }
  }

  // 4. PII detection and scrubbing
  let scrubbedForLog = text;
  let hasPiiDetected = false;

  for (const { name, pattern } of PII_PATTERNS) {
    const matches = text.match(pattern);
    if (matches && matches.length > 0) {
      hasPiiDetected = true;
      scrubbedForLog = scrubbedForLog.replace(pattern, `[REDACTED:${name}]`);
    }
  }

  // sanitizedQuestion for LLM: same as original but truncated and HTML-stripped
  // We do NOT replace PII here — we pass scrubbed version to LLM too for safety
  const sanitizedQuestion = hasPiiDetected ? scrubbedForLog : text;

  return {
    sanitizedQuestion,
    scrubbedForLog,
    hasPiiDetected,
    injectionRisk,
  };
}
