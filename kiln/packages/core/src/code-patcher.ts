import { readFile, writeFile } from 'fs/promises';
import type { PatchResult } from './types.js';

export interface PatchSpec {
  /** Source regex pattern string. */
  pattern: string;
  /** Replacement string — may use $1, $2 capture groups. */
  replacement: string;
  description: string;
}

export interface FilePatches {
  file: string;
  patches: PatchSpec[];
}

/**
 * Apply a list of regex patches to a single file in place.
 * Returns the set of PatchResult records describing what changed.
 * No-op (returns []) if no patterns match.
 */
export async function applyFilePatch(
  filePath: string,
  patches: PatchSpec[],
): Promise<PatchResult[]> {
  const original = await readFile(filePath, 'utf-8');
  let content = original;
  const results: PatchResult[] = [];

  for (const spec of patches) {
    const re = new RegExp(spec.pattern, 'g');
    content = content.replace(re, (match, ...captureAndOffset) => {
      // Last two positional args are offset and full string
      const offset = captureAndOffset[captureAndOffset.length - 2] as number;
      const lineNum =
        original.slice(0, offset).split('\n').length;

      const captures = captureAndOffset.slice(0, captureAndOffset.length - 2) as string[];
      const replaced = spec.replacement.replace(
        /\$(\d+)/g,
        (_, n) => captures[Number(n) - 1] ?? '',
      );

      results.push({
        file: filePath,
        originalLine: lineNum,
        originalCode: match,
        patchedCode: replaced,
      });

      return replaced;
    });
  }

  if (results.length > 0) {
    await writeFile(filePath, content, 'utf-8');
  }

  return results;
}

/**
 * Apply patches across multiple files.
 * Returns a flat array of all PatchResults.
 */
export async function applyBatchPatches(
  filePatches: FilePatches[],
): Promise<PatchResult[]> {
  const allResults: PatchResult[] = [];
  for (const fp of filePatches) {
    const results = await applyFilePatch(fp.file, fp.patches);
    allResults.push(...results);
  }
  return allResults;
}

/**
 * Dry-run: compute what patches would be applied without writing any files.
 * Useful for generating Migration Notes before committing changes.
 */
export async function dryRunPatch(
  filePath: string,
  patches: PatchSpec[],
): Promise<PatchResult[]> {
  const content = await readFile(filePath, 'utf-8');
  const results: PatchResult[] = [];

  for (const spec of patches) {
    const re = new RegExp(spec.pattern, 'g');
    content.replace(re, (match, ...captureAndOffset) => {
      const offset = captureAndOffset[captureAndOffset.length - 2] as number;
      const lineNum = content.slice(0, offset).split('\n').length;

      const captures = captureAndOffset.slice(0, captureAndOffset.length - 2) as string[];
      const replaced = spec.replacement.replace(
        /\$(\d+)/g,
        (_, n) => captures[Number(n) - 1] ?? '',
      );

      results.push({
        file: filePath,
        originalLine: lineNum,
        originalCode: match,
        patchedCode: replaced,
      });

      return match; // no mutation in dry run
    });
  }

  return results;
}
