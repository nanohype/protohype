/**
 * DynamoDB client + DocumentClient helpers.
 * All callers must scope queries on teamId (partition key) to enforce per-tenant isolation.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const REGION = process.env.AWS_REGION ?? 'us-west-2';

/** Raw DynamoDB client. Re-used across Lambda invocations outside the handler. */
export const dynamoClient = new DynamoDBClient({
  region: REGION,
  requestHandler: {
    requestTimeout: 5_000,   // 5 s per call — never default-infinity
  } as { requestTimeout: number },
});

/** DocumentClient for ergonomic marshalling. */
export const docClient = DynamoDBDocumentClient.from(dynamoClient, {
  marshallOptions: { removeUndefinedValues: true, convertEmptyValues: false },
  unmarshallOptions: { wrapNumbers: false },
});

export const TABLE_NAMES = {
  TEAM_CONFIG:    process.env.KILN_TEAM_CONFIG_TABLE    ?? 'kiln-team-config',
  PR_LEDGER:      process.env.KILN_PR_LEDGER_TABLE      ?? 'kiln-pr-ledger',
  CHANGELOG_CACHE:process.env.KILN_CHANGELOG_CACHE_TABLE ?? 'kiln-changelog-cache',
  AUDIT_LOG:      process.env.KILN_AUDIT_LOG_TABLE       ?? 'kiln-audit-log',
  RATE_LIMITER:   process.env.KILN_RATE_LIMITER_TABLE    ?? 'kiln-rate-limiter',
  UPGRADE_STATE:  process.env.KILN_UPGRADE_STATE_TABLE   ?? 'kiln-upgrade-state',
} as const;
