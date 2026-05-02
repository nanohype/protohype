import { describe, expect, it } from "vitest";
import {
  idempotencyDigest,
  idempotencyKeyString,
  messageGroupId,
} from "../../../src/core/github/idempotency.js";
import { asTeamId, type PrIdempotencyKey } from "../../../src/types.js";

const key: PrIdempotencyKey = {
  teamId: asTeamId("team-a"),
  repo: "acme/app",
  pkg: "react",
  fromVersion: "18.0.0",
  toVersion: "19.0.0",
};

describe("idempotency", () => {
  it("digest is stable across calls", () => {
    expect(idempotencyDigest(key)).toBe(idempotencyDigest(key));
  });

  it("changing any field changes the digest", () => {
    const base = idempotencyDigest(key);
    expect(idempotencyDigest({ ...key, teamId: asTeamId("team-b") })).not.toBe(base);
    expect(idempotencyDigest({ ...key, toVersion: "19.0.1" })).not.toBe(base);
  });

  it("keyString is human-readable", () => {
    expect(idempotencyKeyString(key)).toBe("team-a|acme/app|react|18.0.0|19.0.0");
  });

  it("messageGroupId scopes ordering to (team, repo, pkg) — not just team", () => {
    const a = messageGroupId(asTeamId("team-a"), "acme/app", "react");
    const b = messageGroupId(asTeamId("team-a"), "acme/app", "vue");
    expect(a).not.toBe(b); // different pkg → different group → concurrent
  });
});
