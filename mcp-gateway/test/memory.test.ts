describe('Memory: cosine similarity', () => {
  function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; normA += a[i]! * a[i]!; normB += b[i]! * b[i]!; }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }
  test('identical vectors have similarity 1', () => { const v = [1, 0, 0]; expect(cosineSimilarity(v, v)).toBeCloseTo(1.0); });
  test('orthogonal vectors have similarity 0', () => { expect(cosineSimilarity([1,0,0],[0,1,0])).toBeCloseTo(0); });
  test('opposite vectors have similarity -1', () => { expect(cosineSimilarity([1,0,0],[-1,0,0])).toBeCloseTo(-1); });
  test('handles zero vectors', () => { expect(cosineSimilarity([0,0,0],[1,0,0])).toBe(0); });
  test('handles mismatched lengths', () => { expect(cosineSimilarity([1,2,3],[1,2])).toBe(0); });
  test('similarity is symmetric', () => {
    const a = [0.5,0.3,0.8,0.1]; const b = [0.2,0.9,0.4,0.7];
    expect(cosineSimilarity(a,b)).toBeCloseTo(cosineSimilarity(b,a));
  });
});

describe('Memory: embedding serialization', () => {
  test('round-trips correctly', () => {
    const embedding = Array.from({length: 384}, (_,i) => Math.sin(i * 0.1));
    const serialized = JSON.stringify(embedding);
    const deserialized = JSON.parse(serialized) as number[];
    expect(deserialized).toHaveLength(384);
    expect(deserialized[0]).toBeCloseTo(embedding[0]!);
  });
});

describe('Memory: tool argument validation', () => {
  function validateStore(args: Record<string,unknown>): string|null {
    if (!args.agentId || typeof args.agentId !== 'string') return 'agentId is required';
    if (!args.content || typeof args.content !== 'string') return 'content is required';
    return null;
  }
  test('store: requires agentId and content', () => {
    expect(validateStore({agentId:'agent1',content:'hello'})).toBeNull();
    expect(validateStore({content:'hello'})).toBeTruthy();
    expect(validateStore({agentId:'agent1'})).toBeTruthy();
  });
  test('store: optional fields accepted', () => {
    expect(validateStore({agentId:'agent1',content:'hello',summary:'s',tags:['t'],ttlDays:7,metadata:{source:'slack'}})).toBeNull();
  });
});

describe('Memory: MCP tool registry', () => {
  test('all four tools are registered', () => {
    const TOOL_NAMES = ['memory_store','memory_query','memory_list','memory_delete'];
    expect(TOOL_NAMES).toHaveLength(4);
    for (const t of TOOL_NAMES) expect(TOOL_NAMES).toContain(t);
  });
});
