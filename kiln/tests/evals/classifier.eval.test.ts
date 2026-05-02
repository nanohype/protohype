// Classifier eval harness. Skipped unless KILN_RUN_EVALS=1 so it doesn't
// burn AWS budget in every CI run.
//
// Corpus format (tests/evals/fixtures/changelogs/):
//   <pkg>-<from>-<to>.md          the changelog excerpt
//   <pkg>-<from>-<to>.expected.json  ground-truth { ids: string[] }

import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { makeBedrockAdapter } from "../../src/adapters/bedrock/client.js";

const shouldRun = process.env["KILN_RUN_EVALS"] === "1";
const d = shouldRun ? describe : describe.skip;

d("classifier F1 on corpus", () => {
  it("scores ≥ 0.85 F1", async () => {
    const fixturesDir = path.resolve(import.meta.dirname, "fixtures/changelogs");
    let files: string[];
    try {
      files = (await readdir(fixturesDir)).filter((f) => f.endsWith(".md"));
    } catch {
      return; // no corpus yet; nothing to evaluate
    }
    if (files.length === 0) return;

    const llm = makeBedrockAdapter({
      region: process.env["AWS_REGION"] ?? "us-west-2",
      classifierModel: "anthropic.claude-haiku-4-5",
      synthesizerModel: "anthropic.claude-sonnet-4-6",
      synthesizerEscalationModel: "anthropic.claude-opus-4-6",
      timeoutMs: 60_000,
    });

    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const file of files) {
      const body = await readFile(path.join(fixturesDir, file), "utf8");
      const base = file.replace(/\.md$/, "");
      const [pkg, from, to] = base.split("-").reduce<[string, string, string]>(
        (acc, part, i, arr) => {
          if (i < arr.length - 2) acc[0] += (acc[0] ? "-" : "") + part;
          else if (i === arr.length - 2) acc[1] = part;
          else acc[2] = part;
          return acc;
        },
        ["", "", ""],
      );
      const expectedRaw = await readFile(
        path.join(fixturesDir, `${base}.expected.json`),
        "utf8",
      );
      const expected = new Set((JSON.parse(expectedRaw) as { ids: string[] }).ids);

      const result = await llm.classify({ pkg, fromVersion: from, toVersion: to, changelogBody: body });
      if (!result.ok) continue;
      const got = new Set(result.value.breakingChanges.map((bc) => bc.id));
      for (const id of got) (expected.has(id) ? tp++ : fp++);
      for (const id of expected) if (!got.has(id)) fn++;
    }
    const precision = tp === 0 ? 0 : tp / (tp + fp);
    const recall = tp === 0 ? 0 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    expect(f1).toBeGreaterThanOrEqual(0.85);
  });
});
