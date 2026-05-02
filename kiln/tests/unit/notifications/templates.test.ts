import { describe, expect, it } from "vitest";
import { failureBlocks, prOpenedBlocks } from "../../../src/core/notifications/templates.js";
import { asTeamId, type PrRef } from "../../../src/types.js";

const teamId = asTeamId("team-a");
const pr: PrRef = {
  owner: "acme",
  repo: "app",
  number: 42,
  url: "https://github.com/acme/app/pull/42",
  headSha: "abc1234def567890",
};

describe("prOpenedBlocks", () => {
  it("renders PR url, team, and short sha", () => {
    const blocks = prOpenedBlocks(teamId, pr, "Short summary");
    const serialized = JSON.stringify(blocks);
    expect(serialized).toContain(pr.url);
    expect(serialized).toContain("team-a");
    expect(serialized).toContain("abc1234"); // 7-char truncation
    expect(serialized).toContain("Short summary");
  });

  it("caps summary at 2000 characters to stay under Slack block limits", () => {
    const long = "x".repeat(10_000);
    const blocks = prOpenedBlocks(teamId, pr, long);
    const bodyBlock = blocks[1] as { text: { text: string } };
    expect(bodyBlock.text.text.length).toBeLessThanOrEqual(2_000);
  });

  it("structure: header section, body section, sha context", () => {
    const blocks = prOpenedBlocks(teamId, pr, "ok");
    expect(blocks).toHaveLength(3);
    expect(blocks[0]?.type).toBe("section");
    expect(blocks[1]?.type).toBe("section");
    expect(blocks[2]?.type).toBe("context");
  });
});

describe("failureBlocks", () => {
  it("renders team and error message", () => {
    const blocks = failureBlocks(teamId, "rate-limited by GitHub");
    const serialized = JSON.stringify(blocks);
    expect(serialized).toContain("team-a");
    expect(serialized).toContain("rate-limited by GitHub");
    expect(serialized.toLowerCase()).toContain("failed");
  });

  it("caps error message at 1500 chars to prevent log leakage", () => {
    const blocks = failureBlocks(teamId, "x".repeat(10_000));
    const section = blocks[0] as { text: { text: string } };
    expect(section.text.text.length).toBeLessThanOrEqual(1_700); // 1500 body + wrapping
  });
});
