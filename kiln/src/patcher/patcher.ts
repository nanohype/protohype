import type { PatchSpec, PatchResult } from "./types.js";

/**
 * Apply a patch to a file's string content.
 *
 * The patcher:
 * 1. Extracts lines startLine..endLine (1-based, inclusive)
 * 2. Verifies the extracted text matches spec.oldText (content-based, ignoring leading indent)
 * 3. Replaces the lines with spec.newText (preserving the original leading indent)
 * 4. Returns the full patched content
 *
 * This is a pure function — no file I/O. Callers read the file before calling this
 * and write the result after.
 */
export function applyPatch(content: string, spec: PatchSpec): PatchResult {
  const lines = content.split("\n");
  const total = lines.length;

  // Validate line range
  if (spec.startLine < 1 || spec.endLine < spec.startLine || spec.endLine > total) {
    return {
      spec,
      status: "not-found",
      message:
        `Line range ${spec.startLine}–${spec.endLine} is out of bounds ` +
        `(file has ${total} lines)`,
    };
  }

  // Extract target lines (0-indexed)
  const targetLines = lines.slice(spec.startLine - 1, spec.endLine);
  const targetText = targetLines.map((l) => l.trimStart()).join("\n");

  // Check if already patched
  const newNormalized = spec.newText.trim();
  if (targetText.trim() === newNormalized) {
    return { spec, status: "already-patched" };
  }

  // Verify old text matches (content-based, indent-agnostic)
  const oldNormalized = spec.oldText.trim();
  if (targetText.trim() !== oldNormalized) {
    return {
      spec,
      status: "conflict",
      message:
        `Expected:\n${spec.oldText}\n\nActual at lines ${spec.startLine}–${spec.endLine}:\n${targetLines.join("\n")}`,
    };
  }

  // Preserve the leading indent of the first line
  const leadingIndent = targetLines[0].match(/^(\s*)/)?.[1] ?? "";

  // Apply the replacement (preserve indent for each replacement line)
  const replacementLines = spec.newText
    .split("\n")
    .map((l, i) => (i === 0 ? leadingIndent + l.trimStart() : leadingIndent + l.trimStart()));

  const patched = [
    ...lines.slice(0, spec.startLine - 1),
    ...replacementLines,
    ...lines.slice(spec.endLine),
  ].join("\n");

  return { spec, status: "applied", patchedContent: patched };
}

/**
 * Apply multiple patches to a file content in order.
 *
 * Patches are applied sequentially; each patch operates on the result of the previous.
 * Line numbers in later patches must account for line count changes from earlier patches.
 *
 * Returns the final content and all patch results.
 */
export function applyPatches(
  content: string,
  specs: PatchSpec[]
): { finalContent: string; results: PatchResult[] } {
  let current = content;
  const results: PatchResult[] = [];

  for (const spec of specs) {
    const result = applyPatch(current, spec);
    results.push(result);
    if (result.status === "applied" && result.patchedContent !== undefined) {
      current = result.patchedContent;
    }
  }

  return { finalContent: current, results };
}

/**
 * Generate a unified-diff-style summary for a patch result (for PR descriptions).
 */
export function summarizePatch(result: PatchResult): string {
  const { spec, status } = result;
  const location = `${spec.filePath}:${spec.startLine}`;

  switch (status) {
    case "applied":
      return `✅ \`${location}\` — ${spec.reason}`;
    case "already-patched":
      return `⏭ \`${location}\` — already patched`;
    case "not-found":
      return `❓ \`${location}\` — **human review needed**: ${result.message}`;
    case "conflict":
      return `⚠️ \`${location}\` — **conflict**: ${result.message}`;
  }
}
