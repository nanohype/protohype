import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  getTeamConfig,
  putTeamConfig,
  deleteTeamConfig,
  TEAM_CONFIG_TABLE,
} from '../config-store.js';
import type { TeamConfig } from '../types.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

const TEAM_A: TeamConfig = {
  teamId: 'team-alpha',
  repos: ['nanohype/service-a', 'nanohype/service-b'],
  targetVersionPolicy: 'latest',
  reviewSla: 48,
  slackChannel: '#deps-team-alpha',
  pinnedSkipList: ['lodash'],
  groupingStrategy: 'per-family',
  groupingFamilies: { '^@aws-sdk/': 'aws-sdk' },
};

beforeEach(() => {
  ddbMock.reset();
});

describe('getTeamConfig', () => {
  it('returns team config when item exists', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { ...TEAM_A, sk: 'CONFIG#v1' },
    });

    const client = DynamoDBDocumentClient.from({} as never);
    const result = await getTeamConfig('team-alpha', client);
    expect(result).not.toBeNull();
    expect(result!.teamId).toBe('team-alpha');
    expect(result!.repos).toContain('nanohype/service-a');
  });

  it('returns null when item does not exist', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const client = DynamoDBDocumentClient.from({} as never);
    const result = await getTeamConfig('team-missing', client);
    expect(result).toBeNull();
  });

  it('sends the correct table name and key', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const client = DynamoDBDocumentClient.from({} as never);
    await getTeamConfig('team-alpha', client);

    const calls = ddbMock.commandCalls(GetCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.TableName).toBe(TEAM_CONFIG_TABLE);
    expect(calls[0]!.args[0].input.Key).toEqual({
      teamId: 'team-alpha',
      sk: 'CONFIG#v1',
    });
  });

  it('strips the internal sk field from the returned config', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { ...TEAM_A, sk: 'CONFIG#v1' },
    });

    const client = DynamoDBDocumentClient.from({} as never);
    const result = await getTeamConfig('team-alpha', client);
    expect(result).not.toHaveProperty('sk');
  });
});

describe('putTeamConfig', () => {
  it('writes config with the CONFIG#v1 sort key', async () => {
    ddbMock.on(PutCommand).resolves({});

    const client = DynamoDBDocumentClient.from({} as never);
    await putTeamConfig(TEAM_A, client);

    const calls = ddbMock.commandCalls(PutCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.Item).toMatchObject({ sk: 'CONFIG#v1' });
  });

  it('includes a ConditionExpression for isolation', async () => {
    ddbMock.on(PutCommand).resolves({});

    const client = DynamoDBDocumentClient.from({} as never);
    await putTeamConfig(TEAM_A, client);

    const calls = ddbMock.commandCalls(PutCommand);
    expect(calls[0]!.args[0].input.ConditionExpression).toBeTruthy();
  });

  it('propagates DynamoDB errors', async () => {
    ddbMock.on(PutCommand).rejects(new Error('DynamoDB throttled'));

    const client = DynamoDBDocumentClient.from({} as never);
    await expect(putTeamConfig(TEAM_A, client)).rejects.toThrow('DynamoDB throttled');
  });
});

describe('deleteTeamConfig', () => {
  it('sends a DeleteCommand with the correct key', async () => {
    ddbMock.on(DeleteCommand).resolves({});

    const client = DynamoDBDocumentClient.from({} as never);
    await deleteTeamConfig('team-alpha', client);

    const calls = ddbMock.commandCalls(DeleteCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.Key).toEqual({
      teamId: 'team-alpha',
      sk: 'CONFIG#v1',
    });
  });
});
