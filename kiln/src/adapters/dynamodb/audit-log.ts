import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { AuditLogPort } from "../../core/ports.js";
import { err, ok, type AuditRecord, type AuditStatus, type TeamId, type UpgradeId } from "../../types.js";

// Sort key encodes status + time so scans can filter by state, and PITR + object
// lock export gives us the SOC2-grade audit trail.
function sortKey(upgradeId: UpgradeId, startedAt: string): string {
  return `${upgradeId}#${startedAt}`;
}

export function makeAuditLogAdapter(
  doc: DynamoDBDocumentClient,
  tableName: string,
): AuditLogPort {
  return {
    async putUpgradeRecord(rec: AuditRecord) {
      try {
        await doc.send(
          new PutCommand({
            TableName: tableName,
            Item: { ...rec, sk: sortKey(rec.upgradeId, rec.startedAt) },
          }),
        );
        return ok(undefined);
      } catch (e) {
        return err({ kind: "Upstream", source: "dynamodb:audit", message: asMessage(e) });
      }
    },
    async updateUpgradeStatus(
      teamId: TeamId,
      upgradeId: UpgradeId,
      status: AuditStatus,
      patch?: Partial<AuditRecord>,
    ) {
      try {
        // We don't know startedAt here; keep update scoped to the latest sk by scan-free pattern:
        // callers that need full record rewrite should use putUpgradeRecord.
        const exprNames: Record<string, string> = { "#s": "status" };
        const exprVals: Record<string, unknown> = { ":s": status };
        const sets: string[] = ["#s = :s"];
        if (patch?.finishedAt) {
          exprNames["#f"] = "finishedAt";
          exprVals[":f"] = patch.finishedAt;
          sets.push("#f = :f");
        }
        if (patch?.errorMessage) {
          exprNames["#e"] = "errorMessage";
          exprVals[":e"] = patch.errorMessage;
          sets.push("#e = :e");
        }
        if (patch?.prRef) {
          exprNames["#p"] = "prRef";
          exprVals[":p"] = patch.prRef;
          sets.push("#p = :p");
        }
        await doc.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { teamId, sk: sortKey(upgradeId, (patch?.startedAt ?? "")) },
            UpdateExpression: `SET ${sets.join(", ")}`,
            ExpressionAttributeNames: exprNames,
            ExpressionAttributeValues: exprVals,
          }),
        );
        return ok(undefined);
      } catch (e) {
        return err({ kind: "Upstream", source: "dynamodb:audit", message: asMessage(e) });
      }
    },
  };
}

function asMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
