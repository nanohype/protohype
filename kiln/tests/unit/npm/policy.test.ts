import { describe, expect, it } from "vitest";
import { isEligibleUpgrade, isSkipped } from "../../../src/core/npm/policy.js";

describe("version policy", () => {
  it("latest accepts any newer version", () => {
    expect(isEligibleUpgrade("1.0.0", "2.0.0", "latest")).toBe(true);
    expect(isEligibleUpgrade("1.0.0", "1.0.1", "latest")).toBe(true);
  });

  it("minor-only rejects major bumps", () => {
    expect(isEligibleUpgrade("1.0.0", "2.0.0", "minor-only")).toBe(false);
    expect(isEligibleUpgrade("1.0.0", "1.1.0", "minor-only")).toBe(true);
  });

  it("patch-only rejects minor and major bumps", () => {
    expect(isEligibleUpgrade("1.0.0", "1.1.0", "patch-only")).toBe(false);
    expect(isEligibleUpgrade("1.0.0", "1.0.1", "patch-only")).toBe(true);
  });

  it("refuses non-upgrades", () => {
    expect(isEligibleUpgrade("2.0.0", "1.0.0", "latest")).toBe(false);
    expect(isEligibleUpgrade("1.0.0", "1.0.0", "latest")).toBe(false);
  });
});

describe("skip list", () => {
  it("matches exact package names", () => {
    expect(isSkipped("react", ["react", "next"])).toBe(true);
    expect(isSkipped("react-dom", ["react"])).toBe(false);
  });
});
