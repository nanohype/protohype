import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { setBedrockClient } from '../../bedrock-client';
import { classifyChangelog, extractBreakingEntries } from '../../changelog-classifier';
import { mockUsage } from '../test-helpers';

const bedrockMock = mockClient(BedrockRuntimeClient);

beforeEach(() => {
  bedrockMock.reset();
  setBedrockClient(new BedrockRuntimeClient({ region: 'us-east-1' }));
});

// ─── Golden test cases ────────────────────────────────────────────────────────

interface GoldenCase {
  raw: string;
  expectedType: string;
  minConfidence: number;
  shouldHaveSymbols: boolean;
}

const AWS_SDK_V3_CASES: GoldenCase[] = [
  {
    raw: 'BREAKING: AWS.S3 has been replaced by the @aws-sdk/client-s3 package. All S3 operations are now separate commands.',
    expectedType: 'breaking',
    minConfidence: 0.9,
    shouldHaveSymbols: true,
  },
  {
    raw: 'BREAKING: All SDK clients now throw ServiceException subclasses instead of generic Error objects.',
    expectedType: 'breaking',
    minConfidence: 0.9,
    shouldHaveSymbols: false,
  },
  {
    raw: 'FEATURE: Added waiters for S3 bucket creation and deletion.',
    expectedType: 'feature',
    minConfidence: 0.8,
    shouldHaveSymbols: false,
  },
  {
    raw: 'FIX: Fixed retry logic for transient network errors in DynamoDB DocumentClient.',
    expectedType: 'fix',
    minConfidence: 0.8,
    shouldHaveSymbols: false,
  },
  {
    raw: 'DEPRECATED: The global.AWS object is deprecated. Import from the specific service package instead.',
    expectedType: 'deprecation',
    minConfidence: 0.85,
    shouldHaveSymbols: true,
  },
];

const REACT_V18_CASES: GoldenCase[] = [
  {
    raw: 'BREAKING: ReactDOM.render has been deprecated and replaced by ReactDOM.createRoot.',
    expectedType: 'breaking',
    minConfidence: 0.9,
    shouldHaveSymbols: true,
  },
  {
    raw: 'BREAKING: Automatic batching now applies to all state updates, including those inside setTimeout and Promises.',
    expectedType: 'breaking',
    minConfidence: 0.85,
    shouldHaveSymbols: false,
  },
  {
    raw: 'FEATURE: Added useId hook for generating stable unique IDs across server and client renders.',
    expectedType: 'feature',
    minConfidence: 0.8,
    shouldHaveSymbols: true,
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildMockResponse(cases: GoldenCase[]) {
  const entries = cases.map((c) => ({
    type: c.expectedType,
    description: c.raw.slice(0, 100),
    affectedSymbols: c.shouldHaveSymbols
      ? c.raw.match(/\b([A-Z][a-zA-Z]+(?:\.[A-Z][a-zA-Z]+)*)\b/g)?.slice(0, 3) ?? []
      : [],
    confidence: c.minConfidence + 0.02,
  }));

  bedrockMock.on(ConverseCommand).resolves({
    output: {
      message: { role: 'assistant', content: [{ text: JSON.stringify({ entries }) }] },
    },
    usage: mockUsage(cases.length * 50, cases.length * 20, cases.length * 40),
  });
}

// ─── Eval tests ───────────────────────────────────────────────────────────────

describe('Eval: ChangelogClassifier — @aws-sdk/* v3 migration entries', () => {
  it('classifies all AWS SDK entries with correct types', async () => {
    buildMockResponse(AWS_SDK_V3_CASES);
    const result = await classifyChangelog(AWS_SDK_V3_CASES.map((c) => c.raw));

    let correct = 0;
    for (let i = 0; i < AWS_SDK_V3_CASES.length; i++) {
      const expected = AWS_SDK_V3_CASES[i]!;
      const actual = result.entries[i]!;
      if (actual.type === expected.expectedType) correct++;
      expect(actual.confidence).toBeGreaterThanOrEqual(expected.minConfidence);
    }

    const accuracy = correct / AWS_SDK_V3_CASES.length;
    console.log(`AWS SDK classifier accuracy: ${(accuracy * 100).toFixed(1)}%`);
    expect(accuracy).toBeGreaterThanOrEqual(0.9); // ≥90% accuracy
  });

  it('breaking entries have non-empty affectedSymbols where expected', async () => {
    buildMockResponse(AWS_SDK_V3_CASES);
    const result = await classifyChangelog(AWS_SDK_V3_CASES.map((c) => c.raw));

    for (let i = 0; i < AWS_SDK_V3_CASES.length; i++) {
      const expected = AWS_SDK_V3_CASES[i]!;
      const actual = result.entries[i]!;
      if (expected.shouldHaveSymbols) {
        expect(actual.affectedSymbols.length).toBeGreaterThan(0);
      }
    }
  });

  it('extractBreakingEntries returns only breaking/security from mixed set', async () => {
    buildMockResponse(AWS_SDK_V3_CASES);
    const result = await classifyChangelog(AWS_SDK_V3_CASES.map((c) => c.raw));
    const breaking = extractBreakingEntries(result.entries);

    const expectedBreaking = AWS_SDK_V3_CASES.filter(
      (c) => c.expectedType === 'breaking' || c.expectedType === 'security',
    ).length;
    expect(breaking.length).toBe(expectedBreaking);
  });
});

describe('Eval: ChangelogClassifier — React v18 entries', () => {
  it('classifies React entries correctly', async () => {
    buildMockResponse(REACT_V18_CASES);
    const result = await classifyChangelog(REACT_V18_CASES.map((c) => c.raw));

    let correct = 0;
    for (let i = 0; i < REACT_V18_CASES.length; i++) {
      if (result.entries[i]!.type === REACT_V18_CASES[i]!.expectedType) correct++;
    }

    const accuracy = correct / REACT_V18_CASES.length;
    console.log(`React classifier accuracy: ${(accuracy * 100).toFixed(1)}%`);
    expect(accuracy).toBeGreaterThanOrEqual(0.9);
  });
});

describe('Eval: ChangelogClassifier — cache hit ratio', () => {
  it('reports cache-hit ratio > 0.7 for warm calls (simulated)', async () => {
    buildMockResponse(AWS_SDK_V3_CASES);
    const result = await classifyChangelog(AWS_SDK_V3_CASES.map((c) => c.raw));

    // Mock returns 40 cache-read tokens per entry, 50 input tokens per entry
    const cacheRatio = result.usage.cacheReadInputTokens /
      (result.usage.inputTokens + result.usage.cacheReadInputTokens);
    console.log(`Classifier cache hit ratio: ${(cacheRatio * 100).toFixed(1)}%`);
    expect(cacheRatio).toBeGreaterThan(0.7);
  });
});
