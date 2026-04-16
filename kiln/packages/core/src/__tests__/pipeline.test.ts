/**
 * Integration test for the upgrade pipeline.
 * Wires together config-store, grouping, changelog-fetcher, change-analyzer,
 * and audit-logger with mocked DynamoDB and Bedrock clients.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { runUpgradePipeline } from '../pipeline.js';
import type { DepVersion, TeamConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
const ddbMock = mockClient(DynamoDBDocumentClient);
const bedrockMock = mockClient(BedrockRuntimeClient);
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterEach(() => {
  server.resetHandlers();
  ddbMock.reset();
  bedrockMock.reset();
});
afterAll(() => server.close());

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const TEAM_CONFIG: TeamConfig = {
  teamId: 'team-alpha',
  repos: ['nanohype/service-a'],
  targetVersionPolicy: 'latest',
  reviewSla: 48,
  slackChannel: '#deps',
  pinnedSkipList: ['lodash'],
  groupingStrategy: 'per-dep',
  groupingFamilies: {},
};

const REACT_DEP: DepVersion = {
  name: 'react',
  currentVersion: '18.3.1',
  latestVersion: '19.1.0',
  changelogUrl: 'https://github.com/facebook/react/releases',
};

const LODASH_DEP: DepVersion = {
  name: 'lodash',
  currentVersion: '4.17.21',
  latestVersion: '4.18.0',
  changelogUrl: 'https://github.com/lodash/lodash/releases',
};

const AWS_DEP: DepVersion = {
  name: '@aws-sdk/client-s3',
  currentVersion: '3.400.0',
  latestVersion: '3.500.0',
  changelogUrl: 'https://github.com/aws/aws-sdk-js-v3/releases',
};

function mockDdbConfig(config: TeamConfig | null) {
  ddbMock.on(GetCommand).resolves({
    Item: config ? { ...config, sk: 'CONFIG#v1' } : undefined,
  });
  ddbMock.on(PutCommand).resolves({});
}

function mockBedrockAnalysis(
  breakingChanges: Array<{ description: string; apiPattern: string; requiresHumanReview: boolean }>,
) {
  const body = JSON.stringify({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          breakingChanges,
          summary: 'test summary',
        }),
      },
    ],
  });
  bedrockMock.on(InvokeModelCommand).resolves({
    body: new TextEncoder().encode(body),
  });
}

function mockChangelog(url: string, text = '## Changelog\n- v2.0.0 breaking changes') {
  const urlObj = new URL(url);
  server.use(
    http.get(`${urlObj.origin}${urlObj.pathname}`, () => HttpResponse.text(text)),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('runUpgradePipeline', () => {
  it('throws when team config is not found', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const dynamo = DynamoDBDocumentClient.from({} as never);
    const bedrock = new BedrockRuntimeClient({ region: 'us-west-2' });

    await expect(
      runUpgradePipeline([REACT_DEP], {
        teamId: 'unknown-team',
        repoFullName: 'org/repo',
        actor: 'alice@test.com',
        dynamo,
        bedrock,
      }),
    ).rejects.toThrow(/No Kiln config/);
  });

  it('skips deps on the pinnedSkipList', async () => {
    mockDdbConfig(TEAM_CONFIG);
    mockBedrockAnalysis([]);
    mockChangelog(REACT_DEP.changelogUrl!);

    const dynamo = DynamoDBDocumentClient.from({} as never);
    const bedrock = new BedrockRuntimeClient({ region: 'us-west-2' });

    const result = await runUpgradePipeline([REACT_DEP, LODASH_DEP], {
      teamId: 'team-alpha',
      repoFullName: 'org/repo',
      actor: 'alice@test.com',
      dynamo,
      bedrock,
    });

    expect(result.skipped).toContain('lodash');
    expect(result.migrationNotes.has('lodash')).toBe(false);
    expect(result.migrationNotes.has('react')).toBe(true);
  });

  it('creates migration notes for each non-skipped dep', async () => {
    mockDdbConfig(TEAM_CONFIG);
    mockBedrockAnalysis([
      { description: 'API change', apiPattern: 'oldFn', requiresHumanReview: false },
    ]);
    mockChangelog(REACT_DEP.changelogUrl!);

    const dynamo = DynamoDBDocumentClient.from({} as never);
    const bedrock = new BedrockRuntimeClient({ region: 'us-west-2' });

    const result = await runUpgradePipeline([REACT_DEP], {
      teamId: 'team-alpha',
      repoFullName: 'org/repo',
      actor: 'alice@test.com',
      dynamo,
      bedrock,
    });

    const note = result.migrationNotes.get('react');
    expect(note).toBeDefined();
    expect(note!.fromVersion).toBe('18.3.1');
    expect(note!.toVersion).toBe('19.1.0');
    expect(note!.changelogUrl).toBe(REACT_DEP.changelogUrl);
  });

  it('flags humanReviewRequired when any breaking change requires it', async () => {
    mockDdbConfig(TEAM_CONFIG);
    mockChangelog(REACT_DEP.changelogUrl!);
    mockBedrockAnalysis([
      { description: 'Manual migration', apiPattern: 'old', requiresHumanReview: true },
    ]);

    const dynamo = DynamoDBDocumentClient.from({} as never);
    const bedrock = new BedrockRuntimeClient({ region: 'us-west-2' });

    const result = await runUpgradePipeline([REACT_DEP], {
      teamId: 'team-alpha',
      repoFullName: 'org/repo',
      actor: 'alice@test.com',
      dynamo,
      bedrock,
    });

    expect(result.migrationNotes.get('react')!.humanReviewRequired).toBe(true);
  });

  it('creates a migration note flagged for review when changelog URL is missing', async () => {
    mockDdbConfig(TEAM_CONFIG);
    mockBedrockAnalysis([]);

    const depNoUrl: DepVersion = {
      name: 'mystery-pkg',
      currentVersion: '1.0.0',
      latestVersion: '2.0.0',
    };

    const dynamo = DynamoDBDocumentClient.from({} as never);
    const bedrock = new BedrockRuntimeClient({ region: 'us-west-2' });

    const result = await runUpgradePipeline([depNoUrl], {
      teamId: 'team-alpha',
      repoFullName: 'org/repo',
      actor: 'bot',
      dynamo,
      bedrock,
    });

    const note = result.migrationNotes.get('mystery-pkg');
    expect(note!.humanReviewRequired).toBe(true);
  });

  it('records an error and continues when changelog fetch fails', async () => {
    mockDdbConfig(TEAM_CONFIG);
    mockBedrockAnalysis([]);

    // Block changelog fetch for react
    server.use(
      http.get('https://github.com/facebook/react/releases', () =>
        new HttpResponse(null, { status: 500 }),
      ),
    );
    mockChangelog(AWS_DEP.changelogUrl!);

    const dynamo = DynamoDBDocumentClient.from({} as never);
    const bedrock = new BedrockRuntimeClient({ region: 'us-west-2' });

    const result = await runUpgradePipeline([REACT_DEP, AWS_DEP], {
      teamId: 'team-alpha',
      repoFullName: 'org/repo',
      actor: 'bot',
      dynamo,
      bedrock,
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.dependency).toBe('react');
    // AWS dep should still be processed
    expect(result.migrationNotes.has('@aws-sdk/client-s3')).toBe(true);
  });

  it('groups deps according to team config strategy', async () => {
    const config: TeamConfig = {
      ...TEAM_CONFIG,
      groupingStrategy: 'per-family',
      groupingFamilies: { '^@aws-sdk/': 'aws-sdk' },
    };
    mockDdbConfig(config);
    mockBedrockAnalysis([]);

    const awsDep2: DepVersion = {
      name: '@aws-sdk/lib-dynamodb',
      currentVersion: '3.400.0',
      latestVersion: '3.500.0',
      changelogUrl: 'https://github.com/aws/aws-sdk-js-v3/releases',
    };

    mockChangelog('https://github.com/aws/aws-sdk-js-v3/releases');

    const dynamo = DynamoDBDocumentClient.from({} as never);
    const bedrock = new BedrockRuntimeClient({ region: 'us-west-2' });

    const result = await runUpgradePipeline([AWS_DEP, awsDep2], {
      teamId: 'team-alpha',
      repoFullName: 'org/repo',
      actor: 'bot',
      dynamo,
      bedrock,
    });

    // Both @aws-sdk/* deps should be in one group
    const awsGroups = result.groups.filter((g) => g.groupName === 'aws-sdk');
    expect(awsGroups).toHaveLength(1);
    expect(awsGroups[0]!.dependencies).toHaveLength(2);
  });

  it('emits audit events for config read and upgrade triggered', async () => {
    mockDdbConfig(TEAM_CONFIG);
    mockBedrockAnalysis([]);
    mockChangelog(REACT_DEP.changelogUrl!);

    const dynamo = DynamoDBDocumentClient.from({} as never);
    const bedrock = new BedrockRuntimeClient({ region: 'us-west-2' });

    await runUpgradePipeline([REACT_DEP], {
      teamId: 'team-alpha',
      repoFullName: 'org/repo',
      actor: 'alice@test.com',
      dynamo,
      bedrock,
    });

    const putCalls = ddbMock.commandCalls(PutCommand);
    const eventTypes = putCalls.map(
      (c) => (c.args[0].input.Item as Record<string, unknown>)['eventType'],
    );

    expect(eventTypes).toContain('CONFIG_READ');
    expect(eventTypes).toContain('UPGRADE_TRIGGERED');
    expect(eventTypes).toContain('CHANGELOG_FETCHED');
  });
});
