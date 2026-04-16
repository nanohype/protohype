import { describe, it, expect, vi } from "vitest";
import {
  cn,
  relativeTime,
  formatDate,
  prStatusColor,
  truncate,
  groupingStrategyLabel,
} from "./utils";

describe("cn", () => {
  it("merges class names without conflicts", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
    expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500");
  });

  it("handles undefined / false / null gracefully", () => {
    expect(cn("base", undefined, false, null)).toBe("base");
  });
});

describe("relativeTime", () => {
  it("returns 'just now' for < 60 seconds ago", () => {
    const iso = new Date(Date.now() - 10_000).toISOString();
    expect(relativeTime(iso)).toBe("just now");
  });

  it("returns minutes ago", () => {
    const iso = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(relativeTime(iso)).toBe("5m ago");
  });

  it("returns hours ago", () => {
    const iso = new Date(Date.now() - 3 * 3600_000).toISOString();
    expect(relativeTime(iso)).toBe("3h ago");
  });

  it("returns days ago", () => {
    const iso = new Date(Date.now() - 2 * 86400_000).toISOString();
    expect(relativeTime(iso)).toBe("2d ago");
  });
});

describe("prStatusColor", () => {
  it("maps known statuses to correct colours", () => {
    expect(prStatusColor("open")).toBe("green");
    expect(prStatusColor("merged")).toBe("purple");
    expect(prStatusColor("closed")).toBe("gray");
    expect(prStatusColor("flagged_needs_human")).toBe("red");
  });

  it("returns gray for unknown status", () => {
    expect(prStatusColor("unknown_status")).toBe("gray");
  });
});

describe("truncate", () => {
  it("does not truncate strings within limit", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("truncates and appends ellipsis", () => {
    expect(truncate("hello world", 7)).toBe("hello w…");
  });

  it("returns the string unchanged when exactly at limit", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });
});

describe("groupingStrategyLabel", () => {
  it("returns human labels for known strategies", () => {
    expect(groupingStrategyLabel("per-dep")).toBe("Per dependency");
    expect(groupingStrategyLabel("per-family")).toBe(
      "Per family (e.g. @aws-sdk/*)"
    );
    expect(groupingStrategyLabel("per-release-window")).toBe(
      "Per release window"
    );
  });

  it("returns the raw value for unknown strategies", () => {
    expect(groupingStrategyLabel("custom")).toBe("custom");
  });
});

describe("formatDate", () => {
  it("formats an ISO date string", () => {
    // Use a fixed date so the test isn't timezone-flaky in CI
    const result = formatDate("2024-03-15T00:00:00.000Z");
    // The exact locale string varies by node version but should contain "2024"
    expect(result).toContain("2024");
  });
});
