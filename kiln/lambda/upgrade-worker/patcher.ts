/**
 * Code patcher.
 *
 * Applies CodePatch objects to file content strings, then commits the changes
 * to a GitHub branch via the GitHub App token.
 *
 * Patches are applied in reverse line-number order to preserve line offsets.
 * The patcher verifies the `original` field against the actual file content
 * before applying the patch; mismatches are flagged for human review.
 */
import type { CodePatch } from '../shared/types';
import { getFileContent, updateFile } from '../shared/github-app';

export class PatchMismatch extends Error {
  constructor(
    public readonly file: string,
    public readonly line: number,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(`Patch mismatch in ${file}:${line}`);
    this.name = 'PatchMismatch';
  }
}

/**
 * Apply a list of patches to an in-memory file content string.
 * Patches must all target the same file.
 * Applied in reverse line order to preserve offsets.
 */
export function applyPatchesToContent(content: string, patches: CodePatch[]): string {
  const lines = content.split('\n');

  // Sort patches in reverse order by start line so indices stay valid
  const sorted = [...patches].sort((a, b) => b.startLine - a.startLine);

  for (const patch of sorted) {
    const startIdx = patch.startLine - 1;   // 1-based → 0-based
    const endIdx = patch.endLine - 1;

    if (startIdx < 0 || endIdx >= lines.length) {
      throw new PatchMismatch(patch.file, patch.startLine, '[in range]', '[out of bounds]');
    }

    const actualLines = lines.slice(startIdx, endIdx + 1).join('\n');
    // Normalise whitespace for comparison
    const normActual = actualLines.replace(/\s+/g, ' ').trim();
    const normExpected = patch.original.replace(/\s+/g, ' ').trim();

    if (normActual !== normExpected) {
      throw new PatchMismatch(patch.file, patch.startLine, normExpected, normActual);
    }

    const replacementLines = patch.replacement.split('\n');
    lines.splice(startIdx, endIdx - startIdx + 1, ...replacementLines);
  }

  return lines.join('\n');
}

/**
 * Fetch a file from GitHub, apply patches, commit the result.
 * Returns 'patched', 'mismatch' (needs human review), or 'unchanged' (patch is a no-op).
 */
export async function patchAndCommit(params: {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  patches: CodePatch[];
  commitMessagePrefix: string;
}): Promise<'patched' | 'mismatch' | 'unchanged'> {
  // Group patches by file
  const byFile = new Map<string, CodePatch[]>();
  for (const patch of params.patches) {
    const existing = byFile.get(patch.file) ?? [];
    existing.push(patch);
    byFile.set(patch.file, existing);
  }

  let anyPatched = false;

  for (const [filePath, filePatches] of byFile) {
    const file = await getFileContent({
      token: params.token,
      owner: params.owner,
      repo: params.repo,
      path: filePath,
      ref: params.branch,
    });

    if (!file) {
      console.warn(`File not found: ${filePath} — skipping patch`);
      continue;
    }

    let patched: string;
    try {
      patched = applyPatchesToContent(file.content, filePatches);
    } catch (err) {
      if (err instanceof PatchMismatch) {
        return 'mismatch';
      }
      throw err;
    }

    if (patched === file.content) continue;  // no-op

    const descriptions = [...new Set(filePatches.map((p) => p.breakingChangeDescription))];
    const message = `${params.commitMessagePrefix}: patch ${filePath}\n\n${descriptions.join('\n')}`;

    await updateFile({
      token: params.token,
      owner: params.owner,
      repo: params.repo,
      path: filePath,
      content: patched,
      message,
      branch: params.branch,
      blobSha: file.sha,
    });

    anyPatched = true;
  }

  return anyPatched ? 'patched' : 'unchanged';
}
