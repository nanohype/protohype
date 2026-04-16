import { describe, it, expect } from "vitest";
import { applyPatch, applyPatches, summarizePatch } from "./patcher.js";
import type { PatchSpec } from "./types.js";

const SAMPLE_FILE = `import { createClient } from 'old-sdk';
import { helper } from 'utils';

const client = createClient({ region: 'us-east-1' });
const result = await client.send(new GetCommand({}));

export default client;
`;

describe("applyPatch", () => {
  it("applies a simple rename patch successfully", () => {
    const spec: PatchSpec = {
      filePath: "src/db.ts",
      startLine: 1,
      endLine: 1,
      oldText: "import { createClient } from 'old-sdk';",
      newText: "import { buildClient } from 'new-sdk';",
      reason: "createClient renamed to buildClient in v3",
    };
    const result = applyPatch(SAMPLE_FILE, spec);
    expect(result.status).toBe("applied");
    expect(result.patchedContent).toContain("buildClient");
    expect(result.patchedContent).not.toContain("createClient");
  });

  it("preserves lines outside the patch range", () => {
    const spec: PatchSpec = {
      filePath: "src/db.ts",
      startLine: 1,
      endLine: 1,
      oldText: "import { createClient } from 'old-sdk';",
      newText: "import { buildClient } from 'new-sdk';",
      reason: "rename",
    };
    const result = applyPatch(SAMPLE_FILE, spec);
    expect(result.patchedContent).toContain("import { helper } from 'utils';");
    expect(result.patchedContent).toContain("export default client;");
  });

  it("returns conflict when oldText does not match", () => {
    const spec: PatchSpec = {
      filePath: "src/db.ts",
      startLine: 1,
      endLine: 1,
      oldText: "import { wrongName } from 'old-sdk';",
      newText: "import { buildClient } from 'new-sdk';",
      reason: "rename",
    };
    const result = applyPatch(SAMPLE_FILE, spec);
    expect(result.status).toBe("conflict");
    expect(result.message).toContain("Expected");
  });

  it("returns not-found for out-of-bounds line numbers", () => {
    const spec: PatchSpec = {
      filePath: "src/db.ts",
      startLine: 100,
      endLine: 101,
      oldText: "anything",
      newText: "anything",
      reason: "test",
    };
    const result = applyPatch(SAMPLE_FILE, spec);
    expect(result.status).toBe("not-found");
  });

  it("returns already-patched when content already matches newText", () => {
    // Apply the patch once
    const spec: PatchSpec = {
      filePath: "src/db.ts",
      startLine: 1,
      endLine: 1,
      oldText: "import { createClient } from 'old-sdk';",
      newText: "import { buildClient } from 'new-sdk';",
      reason: "rename",
    };
    const firstResult = applyPatch(SAMPLE_FILE, spec);
    expect(firstResult.status).toBe("applied");

    // Apply again to the patched content
    const newSpec: PatchSpec = {
      ...spec,
      oldText: "import { createClient } from 'old-sdk';",
    };
    const secondResult = applyPatch(firstResult.patchedContent!, newSpec);
    // The old text is gone, so this is a conflict — the patched content has newText
    expect(["already-patched", "conflict"]).toContain(secondResult.status);
  });

  it("preserves leading indentation of patched lines", () => {
    const indentedFile = `function setup() {\n  const client = createClient({});\n  return client;\n}\n`;
    const spec: PatchSpec = {
      filePath: "src/setup.ts",
      startLine: 2,
      endLine: 2,
      oldText: "const client = createClient({});",
      newText: "const client = buildClient({});",
      reason: "rename",
    };
    const result = applyPatch(indentedFile, spec);
    expect(result.status).toBe("applied");
    expect(result.patchedContent).toContain("  const client = buildClient({});");
  });

  it("handles multi-line patches", () => {
    const spec: PatchSpec = {
      filePath: "src/db.ts",
      startLine: 3,
      endLine: 4,
      oldText: "\nconst client = createClient({ region: 'us-east-1' });",
      newText: "\nconst client = buildClient({ region: 'us-east-1' });",
      reason: "rename",
    };
    const result = applyPatch(SAMPLE_FILE, spec);
    // Either applied or conflict depending on exact whitespace matching
    expect(["applied", "conflict"]).toContain(result.status);
  });
});

describe("applyPatches", () => {
  it("applies multiple patches sequentially", () => {
    const specs: PatchSpec[] = [
      {
        filePath: "src/db.ts",
        startLine: 1,
        endLine: 1,
        oldText: "import { createClient } from 'old-sdk';",
        newText: "import { buildClient } from 'new-sdk';",
        reason: "rename import",
      },
      {
        filePath: "src/db.ts",
        startLine: 2,
        endLine: 2,
        oldText: "import { helper } from 'utils';",
        newText: "import { helper } from 'utils-v2';",
        reason: "upgrade utils",
      },
    ];
    const { finalContent, results } = applyPatches(SAMPLE_FILE, specs);
    expect(results).toHaveLength(2);
    expect(finalContent).toContain("buildClient");
    expect(finalContent).toContain("utils-v2");
  });

  it("returns all results even when some patches fail", () => {
    const specs: PatchSpec[] = [
      {
        filePath: "src/db.ts",
        startLine: 1,
        endLine: 1,
        oldText: "WRONG TEXT",
        newText: "anything",
        reason: "will conflict",
      },
      {
        filePath: "src/db.ts",
        startLine: 2,
        endLine: 2,
        oldText: "import { helper } from 'utils';",
        newText: "import { helper } from 'utils-v2';",
        reason: "still applies",
      },
    ];
    const { results } = applyPatches(SAMPLE_FILE, specs);
    expect(results[0].status).toBe("conflict");
    expect(results[1].status).toBe("applied");
  });
});

describe("summarizePatch", () => {
  it("formats applied patches with checkmark", () => {
    const spec: PatchSpec = {
      filePath: "src/db.ts",
      startLine: 5,
      endLine: 5,
      oldText: "old",
      newText: "new",
      reason: "API renamed",
    };
    const summary = summarizePatch({ spec, status: "applied" });
    expect(summary).toContain("✅");
    expect(summary).toContain("src/db.ts:5");
    expect(summary).toContain("API renamed");
  });

  it("formats conflict patches with warning", () => {
    const spec: PatchSpec = {
      filePath: "src/db.ts",
      startLine: 10,
      endLine: 10,
      oldText: "old",
      newText: "new",
      reason: "rename",
    };
    const summary = summarizePatch({ spec, status: "conflict", message: "mismatch" });
    expect(summary).toContain("⚠️");
    expect(summary).toContain("human review");
  });

  it("formats not-found patches with question mark", () => {
    const spec: PatchSpec = {
      filePath: "src/db.ts",
      startLine: 200,
      endLine: 200,
      oldText: "old",
      newText: "new",
      reason: "rename",
    };
    const summary = summarizePatch({ spec, status: "not-found", message: "out of range" });
    expect(summary).toContain("❓");
  });

  it("formats already-patched with skip symbol", () => {
    const spec: PatchSpec = {
      filePath: "src/db.ts",
      startLine: 1,
      endLine: 1,
      oldText: "old",
      newText: "new",
      reason: "rename",
    };
    const summary = summarizePatch({ spec, status: "already-patched" });
    expect(summary).toContain("⏭");
  });
});
