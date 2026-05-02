// Idempotency key — used both as the PR ledger sort key and as the SQS
// messageDeduplicationId. Same key means same logical upgrade; dedup wins.

import { createHash } from "node:crypto";
import type { PrIdempotencyKey, TeamId } from "../../types.js";

export function idempotencyKeyString(key: PrIdempotencyKey): string {
  return `${key.teamId}|${key.repo}|${key.pkg}|${key.fromVersion}|${key.toVersion}`;
}

export function idempotencyDigest(key: PrIdempotencyKey): string {
  return createHash("sha256").update(idempotencyKeyString(key)).digest("hex");
}

/**
 * FIFO group-id: narrow enough that noisy tenants don't serialize unrelated work,
 * wide enough that concurrent upgrades of the same (repo, pkg) can't race.
 */
export function messageGroupId(teamId: TeamId, repo: string, pkg: string): string {
  return `${teamId}:${repo}:${pkg}`;
}
