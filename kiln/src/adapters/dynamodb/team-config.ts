import { DeleteCommand, GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { TeamConfigPort } from "../../core/ports.js";
import { err, ok, type Result, type TeamConfig, type TeamId } from "../../types.js";

export function makeTeamConfigAdapter(
  doc: DynamoDBDocumentClient,
  tableName: string,
): TeamConfigPort {
  return {
    async get(teamId: TeamId): Promise<Result<TeamConfig | null>> {
      try {
        const resp = await doc.send(new GetCommand({ TableName: tableName, Key: { teamId } }));
        return ok((resp.Item as TeamConfig | undefined) ?? null);
      } catch (e) {
        return err({ kind: "Upstream", source: "dynamodb:team-config", message: asMessage(e) });
      }
    },
    async put(cfg) {
      try {
        await doc.send(new PutCommand({ TableName: tableName, Item: cfg }));
        return ok(undefined);
      } catch (e) {
        return err({ kind: "Upstream", source: "dynamodb:team-config", message: asMessage(e) });
      }
    },
    async delete(teamId) {
      try {
        await doc.send(new DeleteCommand({ TableName: tableName, Key: { teamId } }));
        return ok(undefined);
      } catch (e) {
        return err({ kind: "Upstream", source: "dynamodb:team-config", message: asMessage(e) });
      }
    },
    async list() {
      // Only the poller IAM role has dynamodb:Scan — other callers get AccessDenied upstream.
      const out: TeamConfig[] = [];
      let lastEvaluatedKey: Record<string, unknown> | undefined;
      try {
        do {
          const resp = await doc.send(
            new ScanCommand({
              TableName: tableName,
              Limit: 100,
              ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
            }),
          );
          for (const item of resp.Items ?? []) out.push(item as TeamConfig);
          lastEvaluatedKey = resp.LastEvaluatedKey;
        } while (lastEvaluatedKey);
        return ok(out);
      } catch (e) {
        return err({ kind: "Upstream", source: "dynamodb:team-config", message: asMessage(e) });
      }
    },
  };
}

function asMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
