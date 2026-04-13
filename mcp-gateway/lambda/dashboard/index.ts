/**
 * Dashboard API Lambda
 * Reads and writes cost events to S3.
 *
 * Routes:
 *   GET  /dashboard/api/summary        — aggregated totals (30d)
 *   GET  /dashboard/api/agents         — per-agent breakdown (30d)
 *   GET  /dashboard/api/agents/{id}    — single agent recent sessions (90d)
 *   GET  /dashboard/api/workflows      — per-workflow breakdown (30d)
 *   GET  /dashboard/api/sessions       — recent sessions (7d)
 *   GET  /dashboard/api/budget         — daily + monthly budget status
 *   POST /dashboard/api/cost           — ingest a cost event
 *
 * S3 key layout (one file per event to avoid read-modify-write races):
 *   cost-events/{YYYY}/{MM}/{DD}/{agentId}/{sessionId}-{timestamp}-{rand}.json
 */
import { S3Client, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { randomBytes } from 'crypto';

const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'us-west-2' });
const BUCKET = process.env.COST_DATA_BUCKET ?? '';

type CostEventSource = 'managed_agents' | 'advisor';

interface CostEvent {
  sessionId: string;
  agentId?: string;
  agentRole?: string;
  workflow?: string;
  model: string;
  speed?: 'standard' | 'fast';
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd: number;
  source: CostEventSource;
  timestamp: string;
}

const VALID_SOURCES: ReadonlySet<string> = new Set(['managed_agents', 'advisor']);
const VALID_SPEEDS: ReadonlySet<string> = new Set(['standard', 'fast']);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

async function listCostEventKeys(prefix: string, maxKeys = 1000): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const result = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, MaxKeys: maxKeys, ContinuationToken: continuationToken }));
    for (const obj of result.Contents ?? []) { if (obj.Key) keys.push(obj.Key); }
    continuationToken = result.NextContinuationToken;
  } while (continuationToken && keys.length < maxKeys);
  return keys;
}

async function readCostEvent(key: string): Promise<CostEvent | null> {
  try {
    const result = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const body = await result.Body?.transformToString();
    return body ? JSON.parse(body) as CostEvent : null;
  } catch { return null; }
}

async function loadRecentEvents(days = 30): Promise<CostEvent[]> {
  const now = new Date();
  const prefixes: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    prefixes.push(`cost-events/${d.getFullYear()}/${mm}/${dd}/`);
  }
  const allKeys = (await Promise.all(prefixes.map((p) => listCostEventKeys(p, 200)))).flat();
  const events: CostEvent[] = [];
  const BATCH = 50;
  for (let i = 0; i < allKeys.length; i += BATCH) {
    const results = await Promise.all(allKeys.slice(i, i + BATCH).map(readCostEvent));
    for (const ev of results) { if (ev) events.push(ev); }
  }
  return events;
}

function validateCostEvent(body: unknown): CostEvent | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Request body must be a JSON object' };
  const b = body as Record<string, unknown>;
  const required = ['sessionId', 'model', 'inputTokens', 'outputTokens', 'costUsd', 'source', 'timestamp'] as const;
  for (const f of required) {
    if (b[f] === undefined || b[f] === null) return { error: `Missing required field: ${f}` };
  }
  if (typeof b.sessionId !== 'string' || typeof b.model !== 'string' || typeof b.timestamp !== 'string') {
    return { error: 'sessionId, model, and timestamp must be strings' };
  }
  if (typeof b.inputTokens !== 'number' || typeof b.outputTokens !== 'number' || typeof b.costUsd !== 'number') {
    return { error: 'inputTokens, outputTokens, and costUsd must be numbers' };
  }
  if (typeof b.source !== 'string' || !VALID_SOURCES.has(b.source)) {
    return { error: `source must be one of: ${[...VALID_SOURCES].join(', ')}` };
  }
  if (Number.isNaN(Date.parse(b.timestamp as string))) {
    return { error: 'timestamp must be a valid ISO 8601 date' };
  }
  if (b.agentId !== undefined && typeof b.agentId !== 'string') {
    return { error: 'agentId must be a string if provided' };
  }
  if (b.speed !== undefined && !(typeof b.speed === 'string' && VALID_SPEEDS.has(b.speed))) {
    return { error: `speed must be one of: ${[...VALID_SPEEDS].join(', ')}` };
  }
  const event: CostEvent = {
    sessionId: b.sessionId,
    model: b.model,
    inputTokens: b.inputTokens,
    outputTokens: b.outputTokens,
    costUsd: b.costUsd,
    source: b.source as CostEventSource,
    timestamp: b.timestamp as string,
  };
  if (typeof b.agentId === 'string') event.agentId = b.agentId;
  if (typeof b.agentRole === 'string') event.agentRole = b.agentRole;
  if (typeof b.workflow === 'string') event.workflow = b.workflow;
  if (typeof b.speed === 'string') event.speed = b.speed as 'standard' | 'fast';
  if (typeof b.cacheReadTokens === 'number') event.cacheReadTokens = b.cacheReadTokens;
  if (typeof b.cacheCreationTokens === 'number') event.cacheCreationTokens = b.cacheCreationTokens;
  return event;
}

function sanitizeKeySegment(s: string): string {
  // S3 keys: keep URL-safe chars only; map everything else to '_'
  return s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);
}

async function writeCostEvent(event: CostEvent): Promise<string> {
  const d = new Date(event.timestamp);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const agentIdSeg = sanitizeKeySegment(event.agentId ?? 'unknown');
  const sessionSeg = sanitizeKeySegment(event.sessionId);
  const ts = d.toISOString().replace(/[:.]/g, '-');
  const rand = randomBytes(4).toString('hex');
  const key = `cost-events/${yyyy}/${mm}/${dd}/${agentIdSeg}/${sessionSeg}/${ts}-${rand}.json`;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: JSON.stringify(event),
    ContentType: 'application/json',
  }));
  return key;
}

function agentKey(ev: CostEvent): string {
  return ev.agentId ?? 'unknown';
}

function sourceBreakdown(events: CostEvent[]): Record<string, { costUsd: number; sessions: number; events: number }> {
  const out: Record<string, { costUsd: number; sessions: Set<string>; events: number }> = {};
  for (const ev of events) {
    const s = ev.source;
    if (!out[s]) out[s] = { costUsd: 0, sessions: new Set(), events: 0 };
    out[s].costUsd += ev.costUsd;
    out[s].sessions.add(ev.sessionId);
    out[s].events += 1;
  }
  const result: Record<string, { costUsd: number; sessions: number; events: number }> = {};
  for (const [k, v] of Object.entries(out)) {
    result[k] = { costUsd: Math.round(v.costUsd * 10000) / 10000, sessions: v.sessions.size, events: v.events };
  }
  return result;
}

async function handleGet(route: string): Promise<APIGatewayProxyResultV2> {
  let data: object;
  if (route === 'summary' || route === '') {
    const events = await loadRecentEvents(30);
    data = {
      period: 'last_30_days',
      totalCostUsd: Math.round(events.reduce((s, e) => s + e.costUsd, 0) * 10000) / 10000,
      totalInputTokens: events.reduce((s, e) => s + e.inputTokens, 0),
      totalOutputTokens: events.reduce((s, e) => s + e.outputTokens, 0),
      sessionCount: new Set(events.map((e) => e.sessionId)).size,
      agentCount: new Set(events.map(agentKey)).size,
      eventCount: events.length,
      bySource: sourceBreakdown(events),
    };
  } else if (route === 'agents') {
    const events = await loadRecentEvents(30);
    const map = new Map<string, { agentId: string; agentRole?: string; totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number; sessionCount: number; lastActivity: string; sessions: Set<string>; bySource: Record<string, number> }>();
    for (const ev of events) {
      const key = agentKey(ev);
      const ex = map.get(key);
      if (ex) {
        ex.totalCostUsd += ev.costUsd;
        ex.totalInputTokens += ev.inputTokens;
        ex.totalOutputTokens += ev.outputTokens;
        ex.sessions.add(ev.sessionId);
        if (ev.timestamp > ex.lastActivity) ex.lastActivity = ev.timestamp;
        if (!ex.agentRole && ev.agentRole) ex.agentRole = ev.agentRole;
        ex.bySource[ev.source] = (ex.bySource[ev.source] ?? 0) + ev.costUsd;
      } else {
        map.set(key, {
          agentId: key,
          agentRole: ev.agentRole,
          totalCostUsd: ev.costUsd,
          totalInputTokens: ev.inputTokens,
          totalOutputTokens: ev.outputTokens,
          sessionCount: 0,
          lastActivity: ev.timestamp,
          sessions: new Set([ev.sessionId]),
          bySource: { [ev.source]: ev.costUsd },
        });
      }
    }
    data = {
      agents: Array.from(map.values())
        .map(({ sessions, bySource, ...rest }) => {
          const roundedBySource: Record<string, number> = {};
          for (const [k, v] of Object.entries(bySource)) roundedBySource[k] = Math.round(v * 10000) / 10000;
          return { ...rest, sessionCount: sessions.size, bySource: roundedBySource };
        })
        .sort((a, b) => b.totalCostUsd - a.totalCostUsd),
      bySource: sourceBreakdown(events),
    };
  } else if (route.startsWith('agents/')) {
    const agentId = decodeURIComponent(route.slice('agents/'.length));
    const events = (await loadRecentEvents(90)).filter((e) => agentKey(e) === agentId);
    data = {
      agentId,
      totalCostUsd: events.reduce((s, e) => s + e.costUsd, 0),
      sessionCount: new Set(events.map((e) => e.sessionId)).size,
      bySource: sourceBreakdown(events),
      recentSessions: events.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 50),
    };
  } else if (route === 'workflows') {
    const events = await loadRecentEvents(30);
    const map = new Map<string, { totalCostUsd: number; agents: Set<string>; sessions: Set<string> }>();
    for (const ev of events) {
      const wf = ev.workflow ?? 'unknown';
      const ex = map.get(wf);
      if (ex) { ex.totalCostUsd += ev.costUsd; ex.agents.add(agentKey(ev)); ex.sessions.add(ev.sessionId); }
      else map.set(wf, { totalCostUsd: ev.costUsd, agents: new Set([agentKey(ev)]), sessions: new Set([ev.sessionId]) });
    }
    data = {
      workflows: Array.from(map.entries())
        .map(([wf, v]) => ({ workflow: wf, totalCostUsd: v.totalCostUsd, agentCount: v.agents.size, sessionCount: v.sessions.size }))
        .sort((a, b) => b.totalCostUsd - a.totalCostUsd),
    };
  } else if (route === 'sessions') {
    const events = await loadRecentEvents(7);
    const map = new Map<string, { sessionId: string; agentId: string; totalCostUsd: number; timestamp: string; workflow?: string; source: CostEventSource }>();
    for (const ev of events) {
      const ex = map.get(ev.sessionId);
      if (ex) ex.totalCostUsd += ev.costUsd;
      else map.set(ev.sessionId, { sessionId: ev.sessionId, agentId: agentKey(ev), totalCostUsd: ev.costUsd, timestamp: ev.timestamp, workflow: ev.workflow, source: ev.source });
    }
    data = { sessions: Array.from(map.values()).sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 100) };
  } else if (route === 'budget') {
    const DAILY = parseFloat(process.env.DAILY_BUDGET_USD ?? '50');
    const MONTHLY = parseFloat(process.env.MONTHLY_BUDGET_USD ?? '1000');
    const [day, month] = await Promise.all([loadRecentEvents(1), loadRecentEvents(30)]);
    const ds = day.reduce((s, e) => s + e.costUsd, 0);
    const ms = month.reduce((s, e) => s + e.costUsd, 0);
    data = {
      daily: { budget: DAILY, spent: Math.round(ds * 10000) / 10000, remaining: Math.round((DAILY - ds) * 10000) / 10000, pct: Math.round((ds / DAILY) * 100), alert: ds > DAILY * 0.8 },
      monthly: { budget: MONTHLY, spent: Math.round(ms * 10000) / 10000, remaining: Math.round((MONTHLY - ms) * 10000) / 10000, pct: Math.round((ms / MONTHLY) * 100), alert: ms > MONTHLY * 0.8 },
    };
  } else {
    return { statusCode: 404, headers: cors, body: JSON.stringify({ error: `Unknown route: ${route}` }) };
  }
  return { statusCode: 200, headers: cors, body: JSON.stringify(data) };
}

async function handlePost(route: string, event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (route !== 'cost') {
    return { statusCode: 404, headers: cors, body: JSON.stringify({ error: `Unknown POST route: ${route}` }) };
  }
  let body: unknown;
  try { body = JSON.parse(event.body ?? '{}'); }
  catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }
  const validated = validateCostEvent(body);
  if ('error' in validated) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: validated.error }) };
  }
  const key = await writeCostEvent(validated);
  return { statusCode: 201, headers: cors, body: JSON.stringify({ stored: true, key }) };
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const path = event.rawPath ?? '';
  const route = path.split('/').filter(Boolean).slice(2).join('/');
  const method = event.requestContext?.http?.method ?? 'GET';
  try {
    if (method === 'GET') return await handleGet(route);
    if (method === 'POST') return await handlePost(route, event);
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: `Method not allowed: ${method}` }) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Dashboard API error:', message);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
