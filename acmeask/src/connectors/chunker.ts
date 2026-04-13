/**
 * Simple token-approximate text chunker.
 * Uses character count as a proxy for token count (1 token ≈ 4 chars for English).
 */
export function chunkText(
  text: string,
  targetTokens: number = 512,
  overlapTokens: number = 64
): string[] {
  const targetChars = targetTokens * 4;
  const overlapChars = overlapTokens * 4;

  if (text.length <= targetChars) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + targetChars, text.length);
    chunks.push(text.slice(start, end));
    start += targetChars - overlapChars;
  }

  return chunks.filter((c) => c.trim().length > 0);
}
