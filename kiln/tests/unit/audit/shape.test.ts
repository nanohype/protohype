import { describe, expect, it } from "vitest";
import { advance, newAuditRecord, withError, withPr } from "../../../src/core/audit/shape.js";
import { asTeamId, asUpgradeId, type PrRef } from "../../../src/types.js";

const now = new Date("2026-04-20T12:00:00.000Z");
const later = new Date("2026-04-20T12:05:00.000Z");
const teamId = asTeamId("team-a");
const upgradeId = asUpgradeId("u-1");

describe("newAuditRecord", () => {
  it("initializes in pending with a startedAt timestamp", () => {
    const rec = newAuditRecord(teamId, upgradeId, "react", "18.0.0", "19.0.0", now);
    expect(rec.status).toBe("pending");
    expect(rec.startedAt).toBe(now.toISOString());
    expect(rec.teamId).toBe(teamId);
    expect(rec.upgradeId).toBe(upgradeId);
    expect(rec.finishedAt).toBeUndefined();
    expect(rec.prRef).toBeUndefined();
  });
});

describe("advance", () => {
  it("updates status without setting finishedAt for in-flight states", () => {
    const started = newAuditRecord(teamId, upgradeId, "react", "18.0.0", "19.0.0", now);
    const classifying = advance(started, "classifying", later);
    expect(classifying.status).toBe("classifying");
    expect(classifying.finishedAt).toBeUndefined();
  });

  it.each(["pr-opened", "failed", "skipped"] as const)("stamps finishedAt for terminal status %s", (status) => {
    const started = newAuditRecord(teamId, upgradeId, "react", "18.0.0", "19.0.0", now);
    const done = advance(started, status, later);
    expect(done.status).toBe(status);
    expect(done.finishedAt).toBe(later.toISOString());
  });

  it("merges patch fields", () => {
    const started = newAuditRecord(teamId, upgradeId, "react", "18.0.0", "19.0.0", now);
    const patched = advance(started, "failed", later, { errorMessage: "boom" });
    expect(patched.errorMessage).toBe("boom");
    expect(patched.finishedAt).toBe(later.toISOString());
  });
});

describe("withPr", () => {
  it("sets status=pr-opened + finishedAt + prRef atomically", () => {
    const started = newAuditRecord(teamId, upgradeId, "react", "18.0.0", "19.0.0", now);
    const pr: PrRef = {
      owner: "acme",
      repo: "app",
      number: 1,
      url: "https://github.com/acme/app/pull/1",
      headSha: "sha",
    };
    const closed = withPr(started, pr, later);
    expect(closed.status).toBe("pr-opened");
    expect(closed.prRef).toEqual(pr);
    expect(closed.finishedAt).toBe(later.toISOString());
  });
});

describe("withError", () => {
  it("sets status=failed + errorMessage + finishedAt", () => {
    const started = newAuditRecord(teamId, upgradeId, "react", "18.0.0", "19.0.0", now);
    const failed = withError(started, "classify failed", later);
    expect(failed.status).toBe("failed");
    expect(failed.errorMessage).toBe("classify failed");
    expect(failed.finishedAt).toBe(later.toISOString());
  });
});
