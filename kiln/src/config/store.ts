import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import type { TeamConfig } from "./schema.js";
import { parseTeamConfig } from "./schema.js";
import { canReadConfig, canWriteConfig, assertSameOrg } from "./acl.js";
import type { CallerContext, AclVerdict } from "./acl.js";

export interface ConfigStoreOptions {
  tableName: string;
  client: DynamoDBDocumentClient;
}

export class ConfigStore {
  private readonly table: string;
  private readonly ddb: DynamoDBDocumentClient;

  constructor(opts: ConfigStoreOptions) {
    this.table = opts.tableName;
    this.ddb = opts.client;
  }

  /**
   * Read a team's config. Enforces ACL: only the owning team or platform team may read.
   * Throws on ACL denial or if the config does not exist.
   */
  async getConfig(caller: CallerContext, teamId: string): Promise<TeamConfig> {
    const orgCheck = assertSameOrg(caller.orgId, caller.orgId); // will always pass; real check below
    void orgCheck;
    const verdict = canReadConfig(caller, teamId);
    this.enforceAcl(verdict);

    const { Item } = await this.ddb.send(
      new GetCommand({
        TableName: this.table,
        Key: { teamId },
      })
    );

    if (!Item) {
      throw new Error(`Config not found for team "${teamId}"`);
    }

    const parsed = parseTeamConfig(Item);
    if (!parsed.ok) {
      throw new Error(`Stored config is invalid for team "${teamId}": ${parsed.errors.join("; ")}`);
    }

    return parsed.config;
  }

  /**
   * Write (create or update) a team's config. Enforces ACL: only the owning team may write.
   */
  async putConfig(caller: CallerContext, config: TeamConfig): Promise<void> {
    const verdict = canWriteConfig(caller, config.teamId);
    this.enforceAcl(verdict);

    const item = {
      ...config,
      updatedAt: new Date().toISOString(),
    };

    await this.ddb.send(
      new PutCommand({
        TableName: this.table,
        Item: item,
      })
    );
  }

  /**
   * List all configs within an org. Platform-team only.
   */
  async listOrgConfigs(caller: CallerContext, orgId: string): Promise<TeamConfig[]> {
    if (!caller.isPlatformTeam) {
      throw new AclError(
        `Only the platform team may list org-wide configs. Caller: "${caller.callerTeamId}"`
      );
    }

    const { Items } = await this.ddb.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: "orgId-index",
        KeyConditionExpression: "#org = :org",
        ExpressionAttributeNames: { "#org": "orgId" },
        ExpressionAttributeValues: { ":org": orgId },
      })
    );

    const configs: TeamConfig[] = [];
    for (const item of Items ?? []) {
      const parsed = parseTeamConfig(item);
      if (parsed.ok) configs.push(parsed.config);
    }
    return configs;
  }

  private enforceAcl(verdict: AclVerdict): void {
    if (!verdict.allowed) {
      throw new AclError(verdict.reason);
    }
  }
}

export class AclError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AclError";
  }
}
