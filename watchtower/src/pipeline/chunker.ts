// ── Recursive text chunker ─────────────────────────────────────────
//
// Splits long text by trying a hierarchy of separators: paragraph →
// line → sentence → word. Each chunk targets `chunkSize` characters
// with a configurable overlap so the LLM sees context across chunk
// boundaries. Deterministic and dependency-free — cheaper than
// pulling packages/pipeline's chunker in for this v0.
//

const DEFAULT_CHUNK_SIZE = 1000;
const DEFAULT_OVERLAP = 100;
const SEPARATORS = ["\n\n", "\n", ". ", " "];

export interface ChunkerOptions {
  readonly chunkSize?: number;
  readonly overlap?: number;
}

export function chunkText(text: string, opts: ChunkerOptions = {}): readonly string[] {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const overlap = opts.overlap ?? DEFAULT_OVERLAP;
  if (chunkSize <= 0) throw new Error("chunkSize must be > 0");
  if (overlap < 0 || overlap >= chunkSize) {
    throw new Error("overlap must be in [0, chunkSize)");
  }

  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= chunkSize) return [trimmed];

  // Recursive split: pick the biggest separator that keeps pieces
  // under chunkSize. Fall back to hard character slicing if no
  // separator splits produce small-enough pieces.
  const segments = splitRecursive(trimmed, chunkSize, SEPARATORS);
  return mergeWithOverlap(segments, chunkSize, overlap);
}

function splitRecursive(text: string, chunkSize: number, seps: readonly string[]): string[] {
  if (text.length <= chunkSize) return [text];
  const [sep, ...rest] = seps;
  if (sep === undefined) {
    // Hard slice — last resort.
    const pieces: string[] = [];
    for (let i = 0; i < text.length; i += chunkSize) {
      pieces.push(text.slice(i, i + chunkSize));
    }
    return pieces;
  }
  const parts = text.split(sep);
  const out: string[] = [];
  for (const part of parts) {
    if (part.length <= chunkSize) {
      out.push(part);
    } else {
      out.push(...splitRecursive(part, chunkSize, rest));
    }
  }
  return out;
}

function mergeWithOverlap(
  pieces: readonly string[],
  chunkSize: number,
  overlap: number,
): readonly string[] {
  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (current.length + piece.length + 1 <= chunkSize) {
      current = current ? `${current} ${piece}` : piece;
    } else {
      if (current) chunks.push(current);
      // seed next chunk with the tail of the previous for context
      if (overlap > 0 && current.length > overlap) {
        current = current.slice(-overlap) + " " + piece;
      } else {
        current = piece;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks.map((c) => c.trim()).filter(Boolean);
}
