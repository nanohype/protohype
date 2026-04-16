import { readFile, readdir, stat } from 'fs/promises';
import { join, extname } from 'path';

export interface UsageLocation {
  file: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column. */
  column: number;
  /** Trimmed source line text. */
  snippet: string;
  matchedPattern: string;
}

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

const DEFAULT_EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '.cache',
]);

/**
 * Recursively walk a repository directory and find all source lines matching
 * any of the provided regex patterns.
 */
export async function scanForUsages(
  repoPath: string,
  patterns: string[],
  excludeDirs: ReadonlySet<string> = DEFAULT_EXCLUDE_DIRS,
): Promise<UsageLocation[]> {
  const results: UsageLocation[] = [];
  const compiledPatterns = patterns.map((p) => ({ re: new RegExp(p), source: p }));

  async function walkDir(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }

    await Promise.all(
      entries.map(async (entry) => {
        if (excludeDirs.has(entry)) return;

        const fullPath = join(dir, entry);
        const info = await stat(fullPath).catch(() => null);
        if (!info) return;

        if (info.isDirectory()) {
          await walkDir(fullPath);
          return;
        }

        if (!SOURCE_EXTENSIONS.has(extname(entry))) return;

        const content = await readFile(fullPath, 'utf-8').catch(() => '');
        const lines = content.split('\n');

        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
          const line = lines[lineIdx] ?? '';
          for (const { re, source } of compiledPatterns) {
            const globalRe = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
            let match: RegExpExecArray | null;
            while ((match = globalRe.exec(line)) !== null) {
              results.push({
                file: fullPath,
                line: lineIdx + 1,
                column: match.index + 1,
                snippet: line.trim(),
                matchedPattern: source,
              });
            }
          }
        }
      }),
    );
  }

  await walkDir(repoPath);
  return results;
}

/**
 * Count how many source files in a directory import a specific package.
 */
export async function countImports(
  repoPath: string,
  packageName: string,
): Promise<number> {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = `(import|require).*['"]${escaped}`;
  const usages = await scanForUsages(repoPath, [pattern]);
  const files = new Set(usages.map((u) => u.file));
  return files.size;
}
