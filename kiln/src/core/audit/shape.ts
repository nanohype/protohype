// Audit record shape — builders only. Writes happen in adapters/dynamodb.

import type { AuditRecord, AuditStatus, PrRef, TeamId, UpgradeId } from "../../types.js";

export function newAuditRecord(
  teamId: TeamId,
  upgradeId: UpgradeId,
  pkg: string,
  fromVersion: string,
  toVersion: string,
  now: Date,
): AuditRecord {
  return {
    teamId,
    upgradeId,
    pkg,
    fromVersion,
    toVersion,
    status: "pending",
    startedAt: now.toISOString(),
  };
}

export function advance(
  record: AuditRecord,
  status: AuditStatus,
  now: Date,
  patch?: Partial<AuditRecord>,
): AuditRecord {
  const finished = status === "pr-opened" || status === "failed" || status === "skipped";
  const base: AuditRecord = { ...record, ...patch, status };
  return finished ? { ...base, finishedAt: now.toISOString() } : base;
}

export function withPr(record: AuditRecord, pr: PrRef, now: Date): AuditRecord {
  return advance(record, "pr-opened", now, { prRef: pr });
}

export function withError(record: AuditRecord, message: string, now: Date): AuditRecord {
  return advance(record, "failed", now, { errorMessage: message });
}
