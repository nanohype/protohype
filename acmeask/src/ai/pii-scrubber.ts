/**
 * PII scrubber for chunk text — runs before LLM call.
 * Replaces detected PII with type-labeled placeholders.
 */
import type { RankedChunk } from '../types';

const PII_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'email', pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  { name: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  { name: 'phone', pattern: /\b(\+1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g },
  { name: 'credit_card', pattern: /\b(?:\d{4}[\s-]?){3}\d{4}\b/g },
  { name: 'aws_access_key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
];

export function scrubChunksPii(chunks: RankedChunk[]): RankedChunk[] {
  return chunks.map((chunk) => ({
    ...chunk,
    chunkText: scrubText(chunk.chunkText),
  }));
}

function scrubText(text: string): string {
  let result = text;
  for (const { name, pattern } of PII_PATTERNS) {
    result = result.replace(pattern, `[REDACTED:${name}]`);
  }
  return result;
}
