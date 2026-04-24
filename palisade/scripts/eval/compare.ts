#!/usr/bin/env tsx
/**
 * Compare `eval/results.json` against `eval/baseline.json`. Exits non-zero
 * when TPR regresses more than MAX_TPR_DROP or FPR rises more than
 * MAX_FPR_RISE. Used as the CI gate — see `.github/workflows/eval.yml`.
 */

import { readFileSync } from "node:fs";

const MAX_TPR_DROP = 0.05;
const MAX_FPR_RISE = 0.02;

interface Summary {
  readonly tpr: number;
  readonly fpr: number;
}

function loadSummary(path: string): Summary {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { summary?: Summary };
  if (!raw.summary) throw new Error(`No summary in ${path}`);
  return raw.summary;
}

const current = loadSummary("eval/results.json");
const baseline = loadSummary("eval/baseline.json");

const tprDrop = baseline.tpr - current.tpr;
const fprRise = current.fpr - baseline.fpr;

const regressions: string[] = [];
if (tprDrop > MAX_TPR_DROP)
  regressions.push(
    `TPR dropped ${tprDrop.toFixed(3)} (max ${MAX_TPR_DROP}); baseline=${baseline.tpr.toFixed(3)} current=${current.tpr.toFixed(3)}`,
  );
if (fprRise > MAX_FPR_RISE)
  regressions.push(
    `FPR rose ${fprRise.toFixed(3)} (max ${MAX_FPR_RISE}); baseline=${baseline.fpr.toFixed(3)} current=${current.fpr.toFixed(3)}`,
  );

if (regressions.length > 0) {
  console.error("palisade-eval regression detected:");
  for (const r of regressions) console.error(`  - ${r}`);
  process.exit(1);
}

console.log(
  `palisade-eval within tolerance. TPR: ${current.tpr.toFixed(3)} (baseline ${baseline.tpr.toFixed(3)}); FPR: ${current.fpr.toFixed(3)} (baseline ${baseline.fpr.toFixed(3)}).`,
);
