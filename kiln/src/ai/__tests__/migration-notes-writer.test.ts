import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { setBedrockClient } from '../bedrock-client';
import { writeMigrationNotes, buildFallbackNotes } from '../migration-notes-writer';
import type { WriteMigrationNotesInput } from '../migration-notes-writer';
import type { FilePatch, HumanReviewCase, ChangelogEntry } from '../types';
import { mockUsage } from './test-helpers';

const bedrockMock = mockClient(BedrockRuntimeClient);

beforeEach(() => {
  bedrockMock.reset();
  setBedrockClient(new BedrockRuntimeClient({ region: 'us-east-1' }));
});

const entry: ChangelogEntry = {
  raw: 'BREAKING: S3Client region required',
  type: 'breaking',
  description: 'S3Client requires explicit region',
  affectedSymbols: ['S3Client'],
  confidence: 0.95,
};

const patch: FilePatch = {
  filePath: 'src/services/storage.ts',
  lineNumber: 2,
  originalLine: "const client = new S3Client({});",
  patchedLine: "const client = new S3Client({ region: 'us-east-1' });",
  explanation: 'Added required region parameter',
  sourceEntry: entry,
};

const reviewCase: HumanReviewCase = {
  filePath: 'src/services/dynamic.ts',
  lineNumber: 10,
  lineContent: "const client = new S3Client(getConfig());",
  reason: 'Dynamic config cannot be patched automatically',
  suggestedAction: 'Ensure getConfig() includes a region property.',
  sourceEntry: entry,
};

const baseInput: WriteMigrationNotesInput = {
  packageName: '@aws-sdk/client-s3',
  fromVersion: '3.0.0',
  toVersion: '3.100.0',
  changelogUrls: ['https://github.com/aws/aws-sdk-js-v3/releases/tag/v3.100.0'],
  patches: [patch],
  humanReviewCases: [reviewCase],
  breakingEntries: [entry],
};

describe('writeMigrationNotes', () => {
  it('throws when no changelog URLs provided', async () => {
    await expect(writeMigrationNotes({ ...baseInput, changelogUrls: [] })).rejects.toThrow(
      /at least one changelog URL/,
    );
  });

  it('returns migration notes with markdown and metadata', async () => {
    bedrockMock.on(ConverseCommand).resolves({
      output: {
        message: {
          role: 'assistant',
          content: [{
            text: JSON.stringify({
              markdown: [
                '## Migration Notes',
                '',
                '### What Kiln Changed',
                '- `src/services/storage.ts:2` — Added required region parameter',
                '',
                '### Needs Human Review',
                '- `src/services/dynamic.ts:10` — Dynamic config cannot be patched',
                '',
                '### Changelog References',
                '- https://github.com/aws/aws-sdk-js-v3/releases/tag/v3.100.0',
              ].join('\n'),
              mechanicalPatchSummary: 'Kiln applied 1 mechanical patch.',
              humanReviewSummary: '1 location requires human review.',
            }),
          }],
        },
      },
      usage: mockUsage(500, 200, 400),
    });

    const result = await writeMigrationNotes(baseInput);

    expect(result.notes.markdown).toContain('## Migration Notes');
    expect(result.notes.markdown).toContain('storage.ts:2');
    expect(result.notes.markdown).toContain('dynamic.ts:10');
    expect(result.notes.changelogUrls).toHaveLength(1);
    expect(result.notes.mechanicalPatchSummary).toBeTruthy();
    expect(result.usage.inputTokens).toBe(500);
  });

  it('appends changelog section if model omits URL citations', async () => {
    const markdownWithoutUrl = '## Migration Notes\n\n### What Kiln Changed\n- Fixed stuff';
    bedrockMock.on(ConverseCommand).resolves({
      output: {
        message: {
          role: 'assistant',
          content: [{ text: JSON.stringify({ markdown: markdownWithoutUrl, mechanicalPatchSummary: 'x', humanReviewSummary: '' }) }],
        },
      },
      usage: mockUsage(100, 50, 80),
    });

    const result = await writeMigrationNotes(baseInput);
    expect(result.notes.markdown).toContain('https://github.com/aws/aws-sdk-js-v3/releases/tag/v3.100.0');
  });

  it('uses Sonnet tier', async () => {
    bedrockMock.on(ConverseCommand).resolves({
      output: { message: { role: 'assistant', content: [{ text: JSON.stringify({ markdown: '## Migration Notes\n- https://github.com/aws/aws-sdk-js-v3/releases/tag/v3.100.0', mechanicalPatchSummary: '', humanReviewSummary: '' }) }] } },
      usage: mockUsage(100, 50, 80),
    });
    await writeMigrationNotes(baseInput);
    expect(bedrockMock.commandCalls(ConverseCommand)[0]?.args[0].input.modelId).toMatch(/sonnet/i);
  });
});

describe('buildFallbackNotes', () => {
  it('produces valid markdown with the migration notes heading', () => {
    const notes = buildFallbackNotes(baseInput);
    expect(notes.markdown).toContain('## Migration Notes');
  });

  it('cites changelog URLs', () => {
    const notes = buildFallbackNotes(baseInput);
    expect(notes.markdown).toContain('https://github.com/aws/aws-sdk-js-v3/releases/tag/v3.100.0');
  });

  it('lists patches by file:line', () => {
    const notes = buildFallbackNotes(baseInput);
    expect(notes.markdown).toContain('storage.ts:2');
    expect(notes.markdown).toContain('Added required region parameter');
  });

  it('lists human-review cases', () => {
    const notes = buildFallbackNotes(baseInput);
    expect(notes.markdown).toContain('dynamic.ts:10');
    expect(notes.markdown).toContain('Needs Human Review');
  });

  it('produces empty humanReviewSummary when no cases', () => {
    const notes = buildFallbackNotes({ ...baseInput, humanReviewCases: [] });
    expect(notes.humanReviewSummary).toBe('');
  });
});
