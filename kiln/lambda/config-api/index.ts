/**
 * Kiln Config API Lambda
 *
 * Handles team configuration CRUD and PR ledger reads.
 * Routes:
 *   POST   /teams/{teamId}/config
 *   GET    /teams/{teamId}/config
 *   PUT    /teams/{teamId}/config
 *   DELETE /teams/{teamId}/config
 *   GET    /teams/{teamId}/prs
 *   GET    /teams/{teamId}/prs/{prId}
 *
 * Identity: teamId scoped from the Okta JWT subject claim verified by the API Gateway
 * Lambda authorizer. The Lambda authorizer puts the teamId in the request context.
 * Cross-team reads are blocked: the teamId in the path MUST match the JWT claim.
 *
 * DynamoDB queries always scope on teamId (PK) — cross-tenant leakage is impossible
 * at the query level, and doubly enforced by IAM condition keys on the execution role.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  PutCommand,
  GetCommand,
  DeleteCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { docClient, TABLE_NAMES } from '../shared/dynamo';
import { writeAuditEvent } from '../shared/audit';
import type { TeamConfig, PrLedgerEntry, ApiError, ApiOk, GroupingStrategy } from '../shared/types';

// ─── Identity extraction ──────────────────────────────────────────────────────

/**
 * Resolve the caller's teamId from the API Gateway authorizer context.
 * Identity comes from the upstream Okta OIDC token — never constructed
 * from email prefix or Okta user-id.
 */
function getCallerIdentity(event: APIGatewayProxyEventV2): {
  teamId: string;
  subject: string;
} {
  // API Gateway v2 Lambda authorizer injects context under requestContext.authorizer.lambda
  const ctx = (event.requestContext as unknown as {
    authorizer?: { lambda?: { teamId?: string; sub?: string } };
  })?.authorizer?.lambda;

  const teamId = ctx?.teamId ?? '';
  const subject = ctx?.sub ?? 'unknown';

  if (!teamId) throw new AuthError('Missing teamId in authorizer context');
  return { teamId, subject };
}

class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

// ─── Response helpers ─────────────────────────────────────────────────────────

function ok<T>(data: T, requestId?: string): APIGatewayProxyResultV2 {
  const body: ApiOk<T> = { data, requestId };
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function created<T>(data: T, requestId?: string): APIGatewayProxyResultV2 {
  const body: ApiOk<T> = { data, requestId };
  return {
    statusCode: 201,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function errorResponse(status: number, code: string, message: string, requestId?: string): APIGatewayProxyResultV2 {
  const body: ApiError = { error: code, message, requestId };
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateGroupingStrategy(g: unknown): g is GroupingStrategy {
  if (typeof g !== 'object' || g === null) return false;
  const obj = g as Record<string, unknown>;
  const strategy = obj['strategy'];
  if (strategy === 'per-dep') return true;
  if (strategy === 'per-family') {
    return Array.isArray(obj['families']) && (obj['families'] as unknown[]).every((f) => typeof f === 'string');
  }
  if (strategy === 'per-release-window') {
    return typeof obj['windowHours'] === 'number' && (obj['windowHours'] as number) > 0;
  }
  return false;
}

function validateTeamConfigBody(body: unknown): { valid: true; value: Omit<TeamConfig, 'teamId' | 'createdAt' | 'updatedAt'> } | { valid: false; error: string } {
  if (typeof body !== 'object' || body === null) return { valid: false, error: 'Body must be an object' };
  const b = body as Record<string, unknown>;

  if (typeof b['githubOrg'] !== 'string' || !b['githubOrg']) return { valid: false, error: 'githubOrg is required' };
  if (!Array.isArray(b['watchedRepos'])) return { valid: false, error: 'watchedRepos must be an array' };
  if (!Array.isArray(b['watchedPackages'])) return { valid: false, error: 'watchedPackages must be an array' };
  if (!validateGroupingStrategy(b['grouping'])) return { valid: false, error: 'grouping strategy is invalid' };
  if (typeof b['reviewSlaHours'] !== 'number' || (b['reviewSlaHours'] as number) < 1) return { valid: false, error: 'reviewSlaHours must be a positive number' };

  return {
    valid: true,
    value: {
      githubOrg: b['githubOrg'] as string,
      watchedRepos: b['watchedRepos'] as string[],
      watchedPackages: b['watchedPackages'] as TeamConfig['watchedPackages'],
      grouping: b['grouping'] as GroupingStrategy,
      reviewSlaHours: b['reviewSlaHours'] as number,
      slackChannelId: typeof b['slackChannelId'] === 'string' ? b['slackChannelId'] : undefined,
      linearTeamId: typeof b['linearTeamId'] === 'string' ? b['linearTeamId'] : undefined,
      pinnedSkipRepos: Array.isArray(b['pinnedSkipRepos']) ? b['pinnedSkipRepos'] as string[] : undefined,
    },
  };
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleGetConfig(teamId: string): Promise<APIGatewayProxyResultV2> {
  const result = await docClient.send(new GetCommand({
    TableName: TABLE_NAMES.TEAM_CONFIG,
    Key: { teamId },
    ConsistentRead: true,
  }));
  if (!result.Item) return errorResponse(404, 'NOT_FOUND', `No config for team ${teamId}`);
  return ok(result.Item as TeamConfig);
}

async function handleCreateConfig(
  teamId: string,
  rawBody: string | null,
  subject: string,
): Promise<APIGatewayProxyResultV2> {
  if (!rawBody) return errorResponse(400, 'BAD_REQUEST', 'Request body is required');

  let body: unknown;
  try { body = JSON.parse(rawBody); } catch { return errorResponse(400, 'BAD_REQUEST', 'Invalid JSON'); }

  const validation = validateTeamConfigBody(body);
  if (!validation.valid) return errorResponse(400, 'BAD_REQUEST', validation.error);

  const now = new Date().toISOString();
  const config: TeamConfig = {
    teamId,
    ...validation.value,
    createdAt: now,
    updatedAt: now,
  };

  await docClient.send(new PutCommand({
    TableName: TABLE_NAMES.TEAM_CONFIG,
    Item: config,
    ConditionExpression: 'attribute_not_exists(teamId)',
  }));

  await writeAuditEvent({ teamId, action: 'config.created', actorIdentity: subject });
  return created(config);
}

async function handleUpdateConfig(
  teamId: string,
  rawBody: string | null,
  subject: string,
): Promise<APIGatewayProxyResultV2> {
  if (!rawBody) return errorResponse(400, 'BAD_REQUEST', 'Request body is required');

  let body: unknown;
  try { body = JSON.parse(rawBody); } catch { return errorResponse(400, 'BAD_REQUEST', 'Invalid JSON'); }

  const validation = validateTeamConfigBody(body);
  if (!validation.valid) return errorResponse(400, 'BAD_REQUEST', validation.error);

  // Fetch existing to preserve createdAt
  const existing = await docClient.send(new GetCommand({
    TableName: TABLE_NAMES.TEAM_CONFIG,
    Key: { teamId },
  }));
  if (!existing.Item) return errorResponse(404, 'NOT_FOUND', `No config for team ${teamId}`);

  const now = new Date().toISOString();
  const updated: TeamConfig = {
    ...(existing.Item as TeamConfig),
    ...validation.value,
    teamId,
    updatedAt: now,
  };

  await docClient.send(new PutCommand({
    TableName: TABLE_NAMES.TEAM_CONFIG,
    Item: updated,
  }));

  await writeAuditEvent({ teamId, action: 'config.updated', actorIdentity: subject });
  return ok(updated);
}

async function handleDeleteConfig(teamId: string, subject: string): Promise<APIGatewayProxyResultV2> {
  const existing = await docClient.send(new GetCommand({
    TableName: TABLE_NAMES.TEAM_CONFIG,
    Key: { teamId },
  }));
  if (!existing.Item) return errorResponse(404, 'NOT_FOUND', `No config for team ${teamId}`);

  await docClient.send(new DeleteCommand({
    TableName: TABLE_NAMES.TEAM_CONFIG,
    Key: { teamId },
  }));

  await writeAuditEvent({ teamId, action: 'config.deleted', actorIdentity: subject });
  return ok({ deleted: true });
}

async function handleListPrs(teamId: string): Promise<APIGatewayProxyResultV2> {
  const result = await docClient.send(new QueryCommand({
    TableName: TABLE_NAMES.PR_LEDGER,
    KeyConditionExpression: 'teamId = :tid',
    ExpressionAttributeValues: { ':tid': teamId },
    ScanIndexForward: false,
    Limit: 50,
  }));
  return ok(result.Items as PrLedgerEntry[]);
}

async function handleGetPr(teamId: string, prId: string): Promise<APIGatewayProxyResultV2> {
  const result = await docClient.send(new GetCommand({
    TableName: TABLE_NAMES.PR_LEDGER,
    Key: { teamId, prId },
    ConsistentRead: true,
  }));
  if (!result.Item) return errorResponse(404, 'NOT_FOUND', `PR ${prId} not found`);
  return ok(result.Item as PrLedgerEntry);
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const requestId = event.requestContext?.requestId ?? randomUUID();

  try {
    const { teamId: callerTeamId, subject } = getCallerIdentity(event);

    const method = event.requestContext.http.method.toUpperCase();
    const path = event.requestContext.http.path;

    // Extract path parameters manually (API GW v2 may inject them but we parse anyway)
    // Pattern: /teams/{teamId}/... or /teams/{teamId}/prs/{prId}
    const teamMatch = path.match(/^\/teams\/([^/]+)/);
    if (!teamMatch) return errorResponse(404, 'NOT_FOUND', 'Route not found', requestId);
    const pathTeamId = teamMatch[1]!;

    // Security: the teamId in the path must match the caller's JWT-derived teamId.
    // This prevents one team from reading another team's config via URL manipulation.
    if (pathTeamId !== callerTeamId) {
      return errorResponse(403, 'FORBIDDEN', 'You can only access your own team resources', requestId);
    }

    const prsMatch = path.match(/^\/teams\/[^/]+\/prs\/(.+)$/);
    const isPrsRoot = /^\/teams\/[^/]+\/prs$/.test(path);
    const isConfigPath = /^\/teams\/[^/]+\/config$/.test(path);

    if (isConfigPath) {
      if (method === 'GET') return await handleGetConfig(pathTeamId);
      if (method === 'POST') return await handleCreateConfig(pathTeamId, event.body ?? null, subject);
      if (method === 'PUT') return await handleUpdateConfig(pathTeamId, event.body ?? null, subject);
      if (method === 'DELETE') return await handleDeleteConfig(pathTeamId, subject);
    }

    if (isPrsRoot && method === 'GET') return await handleListPrs(pathTeamId);
    if (prsMatch && method === 'GET') return await handleGetPr(pathTeamId, decodeURIComponent(prsMatch[1]!));

    return errorResponse(404, 'NOT_FOUND', 'Route not found', requestId);

  } catch (err) {
    if (err instanceof AuthError) {
      return errorResponse(401, 'UNAUTHORIZED', err.message, requestId);
    }
    // Don't leak internals
    const msg = err instanceof Error ? err.message : 'Internal server error';
    console.error('config-api error', { requestId, error: msg });
    return errorResponse(500, 'INTERNAL_ERROR', 'An internal error occurred', requestId);
  }
};
