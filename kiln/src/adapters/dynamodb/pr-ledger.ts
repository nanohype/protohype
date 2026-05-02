import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { idempotencyDigest } from "../../core/github/idempotency.js";
import type { PrLedgerPort, PrRecord } from "../../core/ports.js";
import { err, ok, type PrIdempotencyKey, type PrRef, type TeamId, type UpgradeId } from "../../types.js";

export function makePrLedgerAdapter(
  doc: DynamoDBDocumentClient,
  tableName: string,
): PrLedgerPort {
  return {
    async recordPrOpened(key: PrIdempotencyKey, pr: PrRef, upgradeId: UpgradeId) {
      try {
        const item: PrRecord = {
          teamId: key.teamId,
          upgradeId,
          key,
          pr,
          openedAt: new Date().toISOString(),
        };
        await doc.send(
          new PutCommand({
            TableName: tableName,
            Item: { ...item, idempotencyKey: idempotencyDigest(key) },
            // Idempotent — only the first write per key succeeds.
            ConditionExpression: "attribute_not_exists(idempotencyKey)",
          }),
        );
        return ok(undefined);
      } catch (e) {
        if (isConditionalFailed(e)) {
          return err({ kind: "Conflict", message: "PR already recorded for this idempotency key" });
        }
        return err({ kind: "Upstream", source: "dynamodb:pr-ledger", message: asMessage(e) });
      }
    },
    async findExistingPr(key) {
      try {
        const resp = await doc.send(
          new GetCommand({
            TableName: tableName,
            Key: { teamId: key.teamId, idempotencyKey: idempotencyDigest(key) },
          }),
        );
        const item = resp.Item as (PrRecord & { idempotencyKey: string }) | undefined;
        return ok(item?.pr ?? null);
      } catch (e) {
        return err({ kind: "Upstream", source: "dynamodb:pr-ledger", message: asMessage(e) });
      }
    },
    async listRecent(teamId: TeamId, limit: number) {
      try {
        const resp = await doc.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: "teamId = :t",
            ExpressionAttributeValues: { ":t": teamId },
            Limit: limit,
            ScanIndexForward: false,
          }),
        );
        return ok(((resp.Items ?? []) as PrRecord[]));
      } catch (e) {
        return err({ kind: "Upstream", source: "dynamodb:pr-ledger", message: asMessage(e) });
      }
    },
  };
}

function isConditionalFailed(e: unknown): boolean {
  return typeof e === "object" && e !== null && "name" in e && (e as { name: string }).name === "ConditionalCheckFailedException";
}

function asMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
