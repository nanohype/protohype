/**
 * Team configuration repository.
 * Every query scopes on teamId partition key — cross-team reads are structurally impossible.
 */
import {
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { getDocumentClient } from "./client.js";
import { config } from "../config.js";
import type { TeamConfig } from "../types.js";

const TABLE = config.dynamodb.teamsTable;

export class TeamNotFoundError extends Error {
  constructor(teamId: string) {
    super(`Team config not found: ${teamId}`);
    this.name = "TeamNotFoundError";
  }
}

export class TeamAccessDeniedError extends Error {
  constructor(teamId: string, requestingTeam: string) {
    super(`Team ${requestingTeam} cannot access config for team ${teamId}`);
    this.name = "TeamAccessDeniedError";
  }
}

/**
 * Get team config — requesterTeamIds must include teamId (or caller has platform role).
 * Throws TeamAccessDeniedError on ACL violation; TeamNotFoundError if absent.
 */
export async function getTeamConfig(
  teamId: string,
  requesterTeamIds: string[],
  isPlatformTeam: boolean,
): Promise<TeamConfig> {
  if (!isPlatformTeam && !requesterTeamIds.includes(teamId)) {
    throw new TeamAccessDeniedError(teamId, requesterTeamIds.join(","));
  }

  const client = getDocumentClient();
  const result = await client.send(
    new GetCommand({
      TableName: TABLE,
      Key: { teamId },
    }),
  );

  if (!result.Item) throw new TeamNotFoundError(teamId);
  return result.Item as TeamConfig;
}

export async function putTeamConfig(cfg: TeamConfig): Promise<void> {
  const client = getDocumentClient();
  await client.send(
    new PutCommand({
      TableName: TABLE,
      Item: { ...cfg, updatedAt: new Date().toISOString() },
    }),
  );
}

export async function deleteTeamConfig(
  teamId: string,
  requesterTeamIds: string[],
  isPlatformTeam: boolean,
): Promise<void> {
  if (!isPlatformTeam && !requesterTeamIds.includes(teamId)) {
    throw new TeamAccessDeniedError(teamId, requesterTeamIds.join(","));
  }

  const client = getDocumentClient();
  try {
    await client.send(
      new DeleteCommand({
        TableName: TABLE,
        Key: { teamId },
        ConditionExpression: "attribute_exists(teamId)",
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw new TeamNotFoundError(teamId);
    }
    throw err;
  }
}

/**
 * List all team configs the requester can see.
 * Platform team: all teams. Others: only their own.
 */
export async function listAccessibleTeamConfigs(
  requesterTeamIds: string[],
  isPlatformTeam: boolean,
): Promise<TeamConfig[]> {
  const client = getDocumentClient();

  if (isPlatformTeam) {
    // Full scan for platform team (org-wide visibility)
    const { Items = [] } = await client.send(
      new QueryCommand({
        TableName: TABLE,
        // Scan all items — platform team has org-wide read
        Select: "ALL_ATTRIBUTES",
        KeyConditionExpression: undefined as never,
      }),
    );
    return Items as TeamConfig[];
  }

  // Fetch only the caller's own team configs (N <= 50 teams per user)
  const results = await Promise.all(
    requesterTeamIds.map((id) =>
      client
        .send(new GetCommand({ TableName: TABLE, Key: { teamId: id } }))
        .then((r) => r.Item as TeamConfig | undefined),
    ),
  );
  return results.filter((r): r is TeamConfig => r !== undefined);
}
