export interface PatchSpec {
  /** Repo-relative file path */
  filePath: string;
  /** 1-based line number where the change begins */
  startLine: number;
  /** 1-based line number where the change ends (inclusive) */
  endLine: number;
  /** The text to remove (must match exactly after trimming leading whitespace) */
  oldText: string;
  /** The replacement text (same indent level as oldText will be preserved) */
  newText: string;
  /** Human-readable reason for this patch — included in Migration Notes */
  reason: string;
}

export type PatchStatus = "applied" | "conflict" | "not-found" | "already-patched";

export interface PatchResult {
  spec: PatchSpec;
  status: PatchStatus;
  /** The patched file content (only when status === "applied") */
  patchedContent?: string;
  /** Diagnostic message for conflict or not-found cases */
  message?: string;
}
