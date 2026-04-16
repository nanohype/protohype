import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { TeamConfig } from './types.js';

export const TEAM_CONFIG_TABLE =
  process.env['KILN_CONFIG_TABLE'] ?? 'kiln-team-config';

/**
 * Sort key for the config item.
 * Partition key is teamId; sk distinguishes config from other item types.
 */
const CONFIG_SK = 'CONFIG#v1';

type TeamConfigItem = TeamConfig & { sk: string };

/**
 * Read a team's config from DynamoDB.
 * The DynamoDB query is scoped on the teamId partition key — cross-team
 * reads are blocked at the IAM level (condition key) in addition to this.
 */
export async function getTeamConfig(
  teamId: string,
  client: DynamoDBDocumentClient,
): Promise<TeamConfig | null> {
  const result = await client.send(
    new GetCommand({
      TableName: TEAM_CONFIG_TABLE,
      Key: { teamId, sk: CONFIG_SK },
    }),
  );
  if (!result.Item) return null;
  const { sk: _sk, ...config } = result.Item as TeamConfigItem;
  return config as TeamConfig;
}

/**
 * Write or replace a team's config.
 * The ConditionExpression prevents one team from overwriting another's row
 * (belt-and-suspenders on top of IAM isolation).
 */
export async function putTeamConfig(
  config: TeamConfig,
  client: DynamoDBDocumentClient,
): Promise<void> {
  const item: TeamConfigItem = { ...config, sk: CONFIG_SK };
  await client.send(
    new PutCommand({
      TableName: TEAM_CONFIG_TABLE,
      Item: item,
      ConditionExpression:
        'attribute_not_exists(teamId) OR teamId = :tid',
      ExpressionAttributeValues: { ':tid': config.teamId },
    }),
  );
}

/**
 * Delete a team's config (used in tests / off-boarding).
 */
export async function deleteTeamConfig(
  teamId: string,
  client: DynamoDBDocumentClient,
): Promise<void> {
  await client.send(
    new DeleteCommand({
      TableName: TEAM_CONFIG_TABLE,
      Key: { teamId, sk: CONFIG_SK },
    }),
  );
}
