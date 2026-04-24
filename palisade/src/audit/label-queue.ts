import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { PutCommand, GetCommand, UpdateCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { LabelQueuePort } from "../ports/index.js";
import type { LabelDraft, LabelDraftStatus } from "../types/label.js";

export interface DdbLabelQueueDeps {
  readonly docClient: DynamoDBDocumentClient;
  readonly tableName: string;
}

/**
 * DDB-backed label queue. Single-table:
 *   PK = DRAFT#{draft_id}
 *   SK = META
 * + GSI status-index on (status, proposedAt) for list-by-status queries.
 */
export function createDdbLabelQueue(deps: DdbLabelQueueDeps): LabelQueuePort {
  return {
    async enqueue(draft: LabelDraft): Promise<void> {
      await deps.docClient.send(
        new PutCommand({
          TableName: deps.tableName,
          Item: { PK: `DRAFT#${draft.draftId}`, SK: "META", ...draft },
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
    },

    async get(draftId): Promise<LabelDraft | null> {
      const result = await deps.docClient.send(
        new GetCommand({
          TableName: deps.tableName,
          Key: { PK: `DRAFT#${draftId}`, SK: "META" },
          ConsistentRead: true,
        }),
      );
      if (!result.Item) return null;
      return stripKeys(result.Item);
    },

    async markApproved(draftId, approver): Promise<void> {
      await deps.docClient.send(
        new UpdateCommand({
          TableName: deps.tableName,
          Key: { PK: `DRAFT#${draftId}`, SK: "META" },
          UpdateExpression: "SET #status = :approved, approvedBy = :approver, approvedAt = :ts",
          ConditionExpression: "#status = :pending",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":approved": "APPROVED",
            ":pending": "PENDING_APPROVAL",
            ":approver": approver,
            ":ts": new Date().toISOString(),
          },
        }),
      );
    },

    async markRejected(draftId, rejector, reason): Promise<void> {
      const expr = reason
        ? "SET #status = :rejected, rejectedBy = :rejector, rejectionReason = :reason"
        : "SET #status = :rejected, rejectedBy = :rejector";
      const values: Record<string, unknown> = { ":rejected": "REJECTED", ":rejector": rejector };
      if (reason) values[":reason"] = reason;
      await deps.docClient.send(
        new UpdateCommand({
          TableName: deps.tableName,
          Key: { PK: `DRAFT#${draftId}`, SK: "META" },
          UpdateExpression: expr,
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: values,
        }),
      );
    },

    async list(status: LabelDraftStatus): Promise<LabelDraft[]> {
      const result = await deps.docClient.send(
        new QueryCommand({
          TableName: deps.tableName,
          IndexName: "status-index",
          KeyConditionExpression: "#status = :s",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":s": status },
        }),
      );
      return (result.Items ?? []).map(stripKeys);
    },
  };
}

function stripKeys(item: Record<string, unknown>): LabelDraft {
  const { PK: _pk, SK: _sk, ...rest } = item as Record<string, unknown> & { PK: string; SK: string };
  return rest as unknown as LabelDraft;
}
