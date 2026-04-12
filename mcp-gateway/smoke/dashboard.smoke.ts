import { get, post, testAgentId, testSessionId } from './helpers';

type Source = 'managed_agents' | 'advisor';

interface SummaryResponse {
  period: string;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  sessionCount: number;
  agentCount: number;
  eventCount: number;
  bySource: Record<Source, { costUsd: number; sessions: number; events: number }>;
}

interface AgentRow {
  agentId: string;
  agentRole?: string;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  sessionCount: number;
  lastActivity: string;
  bySource: Record<string, number>;
}

interface AgentsResponse {
  agents: AgentRow[];
  bySource: Record<Source, { costUsd: number; sessions: number; events: number }>;
}

interface WorkflowsResponse {
  workflows: Array<{ workflow: string; totalCostUsd: number; agentCount: number; sessionCount: number }>;
}

interface SessionsResponse {
  sessions: Array<{ sessionId: string; agentId: string; totalCostUsd: number; timestamp: string; workflow?: string; source: Source }>;
}

interface BudgetResponse {
  daily: { budget: number; spent: number; remaining: number; pct: number; alert: boolean };
  monthly: { budget: number; spent: number; remaining: number; pct: number; alert: boolean };
}

interface CostEventPayload {
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
  source: Source;
  timestamp: string;
}

function sampleEvent(overrides: Partial<CostEventPayload> = {}): CostEventPayload {
  return {
    sessionId: testSessionId(),
    agentId: testAgentId(),
    agentRole: 'eng-backend',
    workflow: 'smoke-test',
    model: 'claude-sonnet-4-6',
    speed: 'standard',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0.001,
    source: 'managed_agents',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('dashboard GET — aggregation endpoints', () => {
  test('/summary returns expected shape with bySource', async () => {
    const res = await get<SummaryResponse>('/dashboard/api/summary');
    expect(res.status).toBe(200);
    expect(res.body.period).toBe('last_30_days');
    expect(typeof res.body.totalCostUsd).toBe('number');
    expect(typeof res.body.totalInputTokens).toBe('number');
    expect(typeof res.body.totalOutputTokens).toBe('number');
    expect(typeof res.body.sessionCount).toBe('number');
    expect(typeof res.body.agentCount).toBe('number');
    expect(typeof res.body.eventCount).toBe('number');
    expect(typeof res.body.bySource).toBe('object');
  });

  test('/agents returns agents array + bySource', async () => {
    const res = await get<AgentsResponse>('/dashboard/api/agents');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.agents)).toBe(true);
    expect(typeof res.body.bySource).toBe('object');
  });

  test('/workflows returns workflows array', async () => {
    const res = await get<WorkflowsResponse>('/dashboard/api/workflows');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.workflows)).toBe(true);
  });

  test('/sessions returns sessions array', async () => {
    const res = await get<SessionsResponse>('/dashboard/api/sessions');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.sessions)).toBe(true);
  });

  test('/budget returns daily + monthly with expected shape', async () => {
    const res = await get<BudgetResponse>('/dashboard/api/budget');
    expect(res.status).toBe(200);
    for (const scope of ['daily', 'monthly'] as const) {
      const b = res.body[scope];
      expect(typeof b.budget).toBe('number');
      expect(typeof b.spent).toBe('number');
      expect(typeof b.remaining).toBe('number');
      expect(typeof b.pct).toBe('number');
      expect(typeof b.alert).toBe('boolean');
    }
  });

  test('unknown route under /dashboard/api/ → 404', async () => {
    const res = await get('/dashboard/api/does-not-exist');
    expect(res.status).toBe(404);
  });
});

describe('dashboard POST /cost — ingest', () => {
  test('valid event with required fields only → 201', async () => {
    const payload: CostEventPayload = {
      sessionId: testSessionId(),
      model: 'claude-sonnet-4-6',
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.001,
      source: 'managed_agents',
      timestamp: new Date().toISOString(),
    };
    const res = await post<{ stored: boolean; key: string }>('/dashboard/api/cost', payload);
    expect(res.status).toBe(201);
    expect(res.body.stored).toBe(true);
    expect(res.body.key).toMatch(/^cost-events\/\d{4}\/\d{2}\/\d{2}\//);
  });

  test('valid event with all optional fields → 201', async () => {
    const res = await post<{ stored: boolean; key: string }>('/dashboard/api/cost', sampleEvent());
    expect(res.status).toBe(201);
    expect(res.body.stored).toBe(true);
  });

  test('event without agentId stores under `unknown/` prefix', async () => {
    const payload = sampleEvent();
    delete payload.agentId;
    const res = await post<{ stored: boolean; key: string }>('/dashboard/api/cost', payload);
    expect(res.status).toBe(201);
    expect(res.body.key).toMatch(/\/unknown\//);
  });

  describe('validation errors', () => {
    const bad = (overrides: Partial<CostEventPayload>, omit?: keyof CostEventPayload) => {
      const payload: Partial<CostEventPayload> = sampleEvent(overrides);
      if (omit) delete payload[omit];
      return payload;
    };

    test('missing sessionId → 400', async () => {
      const res = await post('/dashboard/api/cost', bad({}, 'sessionId'));
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: expect.stringMatching(/sessionId/) });
    });

    test('missing model → 400', async () => {
      const res = await post('/dashboard/api/cost', bad({}, 'model'));
      expect(res.status).toBe(400);
    });

    test('missing costUsd → 400', async () => {
      const res = await post('/dashboard/api/cost', bad({}, 'costUsd'));
      expect(res.status).toBe(400);
    });

    test('missing source → 400', async () => {
      const res = await post('/dashboard/api/cost', bad({}, 'source'));
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: expect.stringMatching(/source/) });
    });

    test('missing timestamp → 400', async () => {
      const res = await post('/dashboard/api/cost', bad({}, 'timestamp'));
      expect(res.status).toBe(400);
    });

    test('invalid source → 400', async () => {
      const res = await post('/dashboard/api/cost', sampleEvent({ source: 'other' as Source }));
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: expect.stringMatching(/source/) });
    });

    test('invalid speed → 400', async () => {
      const res = await post('/dashboard/api/cost', sampleEvent({ speed: 'fast-mode' as 'standard' }));
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: expect.stringMatching(/speed/) });
    });

    test('invalid timestamp → 400', async () => {
      const res = await post('/dashboard/api/cost', sampleEvent({ timestamp: 'not-a-date' }));
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: expect.stringMatching(/timestamp/) });
    });

    test('agentId of wrong type → 400', async () => {
      const res = await post('/dashboard/api/cost', { ...sampleEvent(), agentId: 42 });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: expect.stringMatching(/agentId/) });
    });
  });
});

describe('dashboard — ingest + aggregate round-trip', () => {
  test('posted event is reflected in /summary and /agents', async () => {
    const agentId = testAgentId();
    const sessionId = testSessionId();
    const costUsd = 0.0123; // deterministic, unique enough
    const event = sampleEvent({
      agentId,
      sessionId,
      costUsd,
      source: 'advisor',
    });

    const before = await get<SummaryResponse>('/dashboard/api/summary');
    const beforeEvents = before.body.eventCount;

    const post1 = await post<{ stored: boolean; key: string }>('/dashboard/api/cost', event);
    expect(post1.status).toBe(201);

    // S3 PUT is strongly consistent; subsequent List may need a moment.
    // Add a small delay to keep this test stable across regions.
    await new Promise((r) => setTimeout(r, 1500));

    const after = await get<SummaryResponse>('/dashboard/api/summary');
    expect(after.body.eventCount).toBeGreaterThanOrEqual(beforeEvents + 1);
    // 'advisor' source should now be present in bySource
    expect(after.body.bySource.advisor).toBeDefined();

    const agents = await get<AgentsResponse>('/dashboard/api/agents');
    const ourAgent = agents.body.agents.find((a) => a.agentId === agentId);
    expect(ourAgent).toBeDefined();
    expect(ourAgent?.totalCostUsd).toBeCloseTo(costUsd, 3);
    expect(ourAgent?.bySource.advisor).toBeCloseTo(costUsd, 3);
  });
});
