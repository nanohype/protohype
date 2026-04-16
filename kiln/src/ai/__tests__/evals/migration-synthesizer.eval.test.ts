import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { setBedrockClient } from '../../bedrock-client';
import { synthesizeMigration } from '../../migration-synthesizer';
import type { AffectedUsage, ChangelogEntry } from '../../types';
import { mockUsage } from '../test-helpers';

const bedrockMock = mockClient(BedrockRuntimeClient);

beforeEach(() => {
  bedrockMock.reset();
  setBedrockClient(new BedrockRuntimeClient({ region: 'us-east-1' }));
});

// ─── Scenario builders ────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<ChangelogEntry> = {}): ChangelogEntry {
  return {
    raw: 'BREAKING: API changed',
    type: 'breaking',
    description: 'API changed',
    affectedSymbols: [],
    confidence: 0.95,
    ...overrides,
  };
}

function makeUsage(overrides: Partial<AffectedUsage> = {}): AffectedUsage {
  return {
    filePath: 'src/index.ts',
    lineNumber: 1,
    lineContent: '// placeholder',
    changelogEntry: makeEntry(),
    patchStrategy: 'mechanical',
    patchStrategyReason: 'Simple rename',
    ...overrides,
  };
}

// ─── @aws-sdk/* migration scenario ───────────────────────────────────────────

describe('Eval: MigrationSynthesizer — @aws-sdk/* v2 → v3', () => {
  const awsEntry = makeEntry({
    description: 'S3Client constructor now requires explicit region',
    affectedSymbols: ['S3Client', 'new S3Client'],
    raw: 'BREAKING: S3Client constructor requires region parameter',
  });

  const mechanicalUsage = makeUsage({
    filePath: 'src/services/s3.ts',
    lineNumber: 3,
    lineContent: "const s3 = new S3Client({});",
    changelogEntry: awsEntry,
    patchStrategy: 'mechanical',
    patchStrategyReason: 'Add region field to empty config object',
  });

  it('generates a correct mechanical patch for S3Client constructor', async () => {
    bedrockMock.on(ConverseCommand).resolves({
      output: {
        message: {
          role: 'assistant',
          content: [{
            text: JSON.stringify({
              patches: [{
                filePath: 'src/services/s3.ts',
                lineNumber: 3,
                originalLine: "const s3 = new S3Client({});",
                patchedLine: "const s3 = new S3Client({ region: process.env['AWS_REGION'] ?? 'us-east-1' });",
                explanation: "Added required region to S3Client constructor per @aws-sdk/client-s3 v3",
                complexityScore: 2,
              }],
            }),
          }],
        },
      },
      usage: mockUsage(200, 60, 160),
    });

    const result = await synthesizeMigration([mechanicalUsage]);

    expect(result.patches).toHaveLength(1);
    const patch = result.patches[0]!;
    expect(patch.patchedLine).toContain('region');
    expect(patch.patchedLine.trim()).not.toBe('');
    // Indentation preserved
    const indent = mechanicalUsage.lineContent.match(/^\s*/)?.[0] ?? '';
    expect(patch.patchedLine.startsWith(indent)).toBe(true);
    expect(patch.explanation).toBeTruthy();
  });
});

// ─── React v17 → v18 scenario ────────────────────────────────────────────────

describe('Eval: MigrationSynthesizer — React v17 → v18', () => {
  const reactEntry = makeEntry({
    description: 'ReactDOM.render replaced by createRoot API',
    affectedSymbols: ['ReactDOM.render', 'createRoot'],
    raw: 'BREAKING: ReactDOM.render has been deprecated; use ReactDOM.createRoot(el).render(jsx) instead',
  });

  const renderUsage = makeUsage({
    filePath: 'src/index.tsx',
    lineNumber: 8,
    lineContent: "ReactDOM.render(<App />, document.getElementById('root'));",
    changelogEntry: reactEntry,
    patchStrategy: 'mechanical',
    patchStrategyReason: 'ReactDOM.render → createRoot().render() is a deterministic substitution',
  });

  it('generates patch replacing ReactDOM.render with createRoot', async () => {
    bedrockMock.on(ConverseCommand).resolves({
      output: {
        message: {
          role: 'assistant',
          content: [{
            text: JSON.stringify({
              patches: [{
                filePath: 'src/index.tsx',
                lineNumber: 8,
                originalLine: "ReactDOM.render(<App />, document.getElementById('root'));",
                patchedLine: "ReactDOM.createRoot(document.getElementById('root')!).render(<App />);",
                explanation: "Migrated from deprecated ReactDOM.render to createRoot API (React 18)",
                complexityScore: 3,
              }],
            }),
          }],
        },
      },
      usage: mockUsage(150, 50, 120),
    });

    const result = await synthesizeMigration([renderUsage]);

    expect(result.patches).toHaveLength(1);
    expect(result.patches[0]!.patchedLine).toContain('createRoot');
    expect(result.patches[0]!.explanation).toBeTruthy();
  });

  const dynamicRenderUsage = makeUsage({
    filePath: 'src/utils/renderer.tsx',
    lineNumber: 15,
    lineContent: "ReactDOM.render(element, target);",
    changelogEntry: reactEntry,
    patchStrategy: 'human-review',
    patchStrategyReason: 'Dynamic target element — cannot determine if it has already been createRoot-ed',
  });

  it('flags dynamic ReactDOM.render as human-review', async () => {
    bedrockMock.on(ConverseCommand).resolves({
      output: {
        message: {
          role: 'assistant',
          content: [{
            text: JSON.stringify({
              cases: [{
                filePath: 'src/utils/renderer.tsx',
                lineNumber: 15,
                lineContent: "ReactDOM.render(element, target);",
                reason: 'The target element is dynamic — Kiln cannot verify it has not already been passed to createRoot',
                suggestedAction: 'Refactor to track createRoot instances and call .render() on the existing root, or create a new root if target is guaranteed unique.',
              }],
            }),
          }],
        },
      },
      usage: mockUsage(100, 40, 80),
    });

    const result = await synthesizeMigration([dynamicRenderUsage]);

    expect(result.humanReviewCases).toHaveLength(1);
    const review = result.humanReviewCases[0]!;
    expect(review.reason).toBeTruthy();
    expect(review.suggestedAction).toBeTruthy();
    expect(review.suggestedAction.length).toBeGreaterThan(20); // concrete, not a stub
  });
});

// ─── Prisma v4 → v5 scenario ─────────────────────────────────────────────────

describe('Eval: MigrationSynthesizer — Prisma v4 → v5', () => {
  const prismaEntry = makeEntry({
    description: 'PrismaClient.$on() method renamed to $on() with updated event names',
    affectedSymbols: ['PrismaClient', '$on'],
    raw: 'BREAKING: prisma.$on() event names changed: "beforeExit" removed, "beforeDisconnect" added',
  });

  const reviewUsage = makeUsage({
    filePath: 'src/db/client.ts',
    lineNumber: 12,
    lineContent: "prisma.$on('beforeExit', async () => { await prisma.$disconnect(); });",
    changelogEntry: prismaEntry,
    patchStrategy: 'human-review',
    patchStrategyReason: 'beforeExit event removed — replacement event has different semantics',
  });

  it('flags Prisma event name changes as requiring human review with actionable suggestion', async () => {
    bedrockMock.on(ConverseCommand).resolves({
      output: {
        message: {
          role: 'assistant',
          content: [{
            text: JSON.stringify({
              cases: [{
                filePath: 'src/db/client.ts',
                lineNumber: 12,
                lineContent: "prisma.$on('beforeExit', async () => { await prisma.$disconnect(); });",
                reason: "The 'beforeExit' event was removed in Prisma v5; 'beforeDisconnect' has different invocation semantics",
                suggestedAction: "Replace 'beforeExit' with 'beforeDisconnect'. Note: 'beforeDisconnect' fires before explicit $disconnect() calls but not on process exit. Add a process.on('exit') handler if you relied on the exit-time behavior.",
              }],
            }),
          }],
        },
      },
      usage: mockUsage(150, 60, 120),
    });

    const result = await synthesizeMigration([reviewUsage]);

    expect(result.humanReviewCases).toHaveLength(1);
    const review = result.humanReviewCases[0]!;
    expect(review.suggestedAction).toContain('beforeDisconnect');
  });
});

// ─── Cost and model selection eval ───────────────────────────────────────────

describe('Eval: MigrationSynthesizer — model selection', () => {
  it('escalates to Opus for high-complexity usages (complexity ≥ threshold)', async () => {
    // Create a usage with many symbols (triggers high complexity estimate)
    const complexEntry = makeEntry({
      description: 'Generic type parameters removed from ClientOptions interface — see migration guide',
      affectedSymbols: ['ClientOptions', 'ServiceClient', 'CommandInput', 'CommandOutput', 'HttpHandler', 'RequestSerializer', 'ResponseDeserializer'],
      raw: 'BREAKING: Generic type parameters removed',
    });

    const complexUsage = makeUsage({
      changelogEntry: complexEntry,
      patchStrategy: 'mechanical',
    });

    bedrockMock.on(ConverseCommand).resolves({
      output: {
        message: {
          role: 'assistant',
          content: [{ text: JSON.stringify({ patches: [{ filePath: 'src/index.ts', lineNumber: 1, originalLine: '// placeholder', patchedLine: '// placeholder', explanation: 'No change needed', complexityScore: 9 }] }) }],
        },
      },
      usage: mockUsage(200, 50, 160),
    });

    await synthesizeMigration([complexUsage]);

    const calls = bedrockMock.commandCalls(ConverseCommand);
    // High complexity (7+ symbols → score ~10.5 but capped at 10 > threshold of 7)
    // Should use Opus
    expect(calls[0]?.args[0].input.modelId).toMatch(/opus/i);
  });

  it('uses Sonnet for low-complexity usages', async () => {
    const simpleEntry = makeEntry({
      description: 'Renamed getItem to getObject',
      affectedSymbols: ['getItem'],
      raw: 'BREAKING: getItem renamed to getObject',
    });

    const simpleUsage = makeUsage({ changelogEntry: simpleEntry, patchStrategy: 'mechanical' });

    bedrockMock.on(ConverseCommand).resolves({
      output: {
        message: {
          role: 'assistant',
          content: [{ text: JSON.stringify({ patches: [] }) }],
        },
      },
      usage: mockUsage(50, 10, 40),
    });

    await synthesizeMigration([simpleUsage]);

    const calls = bedrockMock.commandCalls(ConverseCommand);
    expect(calls[0]?.args[0].input.modelId).toMatch(/sonnet/i);
  });
});
