import { describe, it, expect } from "vitest";
import {
  AddRepoSchema,
  NotificationSettingsSchema,
  GroupingSettingsSchema,
} from "./schemas";

describe("AddRepoSchema", () => {
  it("accepts valid owner/repo format", () => {
    const r = AddRepoSchema.safeParse({
      fullName: "acme/my-app",
      installationId: 12345678,
    });
    expect(r.success).toBe(true);
  });

  it("rejects missing slash", () => {
    const r = AddRepoSchema.safeParse({ fullName: "acme", installationId: 1 });
    expect(r.success).toBe(false);
  });

  it("rejects zero installationId", () => {
    const r = AddRepoSchema.safeParse({
      fullName: "acme/repo",
      installationId: 0,
    });
    expect(r.success).toBe(false);
  });

  it("defaults defaultBranch to main", () => {
    const r = AddRepoSchema.safeParse({
      fullName: "acme/repo",
      installationId: 1,
    });
    expect(r.success && r.data.defaultBranch).toBe("main");
  });
});

describe("NotificationSettingsSchema", () => {
  it("accepts a valid Slack channel ID and SLA", () => {
    const r = NotificationSettingsSchema.safeParse({
      slackChannelId: "C01234ABCDE",
      reviewSlaDays: "7",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.reviewSlaDays).toBe(7);
  });

  it("rejects SLA above 90", () => {
    const r = NotificationSettingsSchema.safeParse({
      slackChannelId: "C01234ABCDE",
      reviewSlaDays: "91",
    });
    expect(r.success).toBe(false);
  });

  it("rejects channel IDs not starting with C", () => {
    const r = NotificationSettingsSchema.safeParse({
      slackChannelId: "D01234ABCDE",
      reviewSlaDays: "7",
    });
    expect(r.success).toBe(false);
  });

  it("allows empty slackChannelId", () => {
    const r = NotificationSettingsSchema.safeParse({
      slackChannelId: "",
      reviewSlaDays: "7",
    });
    expect(r.success).toBe(true);
  });
});

describe("GroupingSettingsSchema", () => {
  it("accepts per-dep with no patterns", () => {
    const r = GroupingSettingsSchema.safeParse({
      groupingStrategy: "per-dep",
      familyPatterns: [],
    });
    expect(r.success).toBe(true);
  });

  it("rejects per-family with no patterns", () => {
    const r = GroupingSettingsSchema.safeParse({
      groupingStrategy: "per-family",
      familyPatterns: [],
    });
    expect(r.success).toBe(false);
  });

  it("accepts per-family with at least one pattern", () => {
    const r = GroupingSettingsSchema.safeParse({
      groupingStrategy: "per-family",
      familyPatterns: [{ pattern: "@aws-sdk/*", label: "AWS SDK" }],
    });
    expect(r.success).toBe(true);
  });

  it("rejects unknown strategy", () => {
    const r = GroupingSettingsSchema.safeParse({
      groupingStrategy: "per-sprint",
      familyPatterns: [],
    });
    expect(r.success).toBe(false);
  });
});
