// PR body + migration notes composition. Pure — given a classification and
// synthesis result, produce the markdown that'll land in the GitHub PR.

import type { BreakingChange, CallSite, FilePatch } from "../../types.js";

export interface PrBodyInput {
  pkg: string;
  fromVersion: string;
  toVersion: string;
  summary: string;
  breakingChanges: BreakingChange[];
  patches: FilePatch[];
  callSites: CallSite[];
  modelsUsed: { classifier: string; synthesizer: string };
  warnings?: string[];
}

export function renderPrTitle(pkg: string, fromVersion: string, toVersion: string): string {
  return `chore(deps): upgrade ${pkg} ${fromVersion} → ${toVersion}`;
}

export function renderBranchName(pkg: string, toVersion: string): string {
  const safe = pkg.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return `kiln/${safe}-${toVersion}`;
}

export function renderPrBody(input: PrBodyInput): string {
  const parts: string[] = [];

  parts.push(`## ${input.pkg} ${input.fromVersion} → ${input.toVersion}`);
  parts.push("");
  parts.push("> Opened by [kiln](https://github.com/nanohype/kiln) — patches applied, changelog cited, awaiting human review.");
  parts.push("");

  if (input.summary) {
    parts.push("### Summary");
    parts.push(input.summary);
    parts.push("");
  }

  if (input.breakingChanges.length > 0) {
    parts.push("### Breaking changes detected");
    for (const bc of input.breakingChanges) {
      parts.push(`- **${bc.title}** (${bc.severity}) — [changelog](${bc.changelogUrl})`);
      if (bc.affectedSymbols.length > 0) {
        parts.push(`  - Affected symbols: ${bc.affectedSymbols.map((s) => `\`${s}\``).join(", ")}`);
      }
    }
    parts.push("");
  }

  if (input.callSites.length > 0) {
    parts.push("### Call sites touched");
    for (const cs of input.callSites) {
      parts.push(`- \`${cs.path}:${cs.line}\` — ${cs.symbol}`);
    }
    parts.push("");
  }

  if (input.patches.length > 0) {
    parts.push("### Patches");
    parts.push(`Applied ${input.patches.length} file change(s). See the diff.`);
    parts.push("");
  }

  if (input.warnings && input.warnings.length > 0) {
    parts.push("### Warnings");
    for (const w of input.warnings) parts.push(`- ${w}`);
    parts.push("");
  }

  parts.push("---");
  parts.push(`<sub>classifier: \`${input.modelsUsed.classifier}\` · synthesizer: \`${input.modelsUsed.synthesizer}\`</sub>`);

  return parts.join("\n");
}
