import { describe, it, expect } from 'vitest';
import { groupDependencies, findFamilyGroup } from '../grouping.js';
import type { DepVersion } from '../types.js';

const AWS_DEPS: DepVersion[] = [
  { name: '@aws-sdk/client-s3', currentVersion: '3.400.0', latestVersion: '3.500.0' },
  { name: '@aws-sdk/client-dynamodb', currentVersion: '3.400.0', latestVersion: '3.500.0' },
  { name: '@aws-sdk/lib-dynamodb', currentVersion: '3.400.0', latestVersion: '3.500.0' },
];

const MIXED_DEPS: DepVersion[] = [
  ...AWS_DEPS,
  { name: 'react', currentVersion: '18.0.0', latestVersion: '19.0.0' },
  { name: 'prisma', currentVersion: '4.0.0', latestVersion: '5.0.0' },
];

describe('groupDependencies — per-dep', () => {
  it('creates one group per dependency', () => {
    const groups = groupDependencies(MIXED_DEPS, 'team-a', 'org/repo', {
      groupingStrategy: 'per-dep',
      groupingFamilies: {},
    });

    expect(groups).toHaveLength(MIXED_DEPS.length);
    for (const group of groups) {
      expect(group.dependencies).toHaveLength(1);
      expect(group.strategy).toBe('per-dep');
    }
  });

  it('names each group after the dependency', () => {
    const groups = groupDependencies(AWS_DEPS, 'team-a', 'org/repo', {
      groupingStrategy: 'per-dep',
      groupingFamilies: {},
    });

    const names = groups.map((g) => g.groupName);
    expect(names).toContain('@aws-sdk/client-s3');
    expect(names).toContain('@aws-sdk/client-dynamodb');
  });
});

describe('groupDependencies — per-family', () => {
  const config = {
    groupingStrategy: 'per-family' as const,
    groupingFamilies: {
      '^@aws-sdk/': 'aws-sdk',
      '^react': 'react-family',
    },
  };

  it('groups all @aws-sdk/* into a single aws-sdk group', () => {
    const groups = groupDependencies(MIXED_DEPS, 'team-a', 'org/repo', config);
    const awsGroup = groups.find((g) => g.groupName === 'aws-sdk');
    expect(awsGroup).toBeDefined();
    expect(awsGroup!.dependencies).toHaveLength(3);
    expect(awsGroup!.strategy).toBe('per-family');
  });

  it('does NOT split @aws-sdk/* into multiple groups (grouping correctness)', () => {
    const groups = groupDependencies(AWS_DEPS, 'team-a', 'org/repo', config);
    const awsGroups = groups.filter((g) => g.groupName === 'aws-sdk');
    expect(awsGroups).toHaveLength(1);
  });

  it('falls back unmatched deps to per-dep', () => {
    const groups = groupDependencies(MIXED_DEPS, 'team-a', 'org/repo', config);
    const prismaGroup = groups.find((g) => g.groupName === 'prisma');
    expect(prismaGroup).toBeDefined();
    expect(prismaGroup!.strategy).toBe('per-dep');
  });

  it('handles an empty families map (all deps fall back to per-dep)', () => {
    const groups = groupDependencies(MIXED_DEPS, 'team-a', 'org/repo', {
      groupingStrategy: 'per-family',
      groupingFamilies: {},
    });

    expect(groups).toHaveLength(MIXED_DEPS.length);
    for (const g of groups) expect(g.strategy).toBe('per-dep');
  });
});

describe('groupDependencies — per-release-window', () => {
  it('puts all deps into a single group', () => {
    const groups = groupDependencies(MIXED_DEPS, 'team-a', 'org/repo', {
      groupingStrategy: 'per-release-window',
      groupingFamilies: {},
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]!.dependencies).toHaveLength(MIXED_DEPS.length);
    expect(groups[0]!.strategy).toBe('per-release-window');
  });

  it('names the group with today's ISO date', () => {
    const groups = groupDependencies(MIXED_DEPS, 'team-a', 'org/repo', {
      groupingStrategy: 'per-release-window',
      groupingFamilies: {},
    });

    const today = new Date().toISOString().slice(0, 10);
    expect(groups[0]!.groupName).toBe(`release-window-${today}`);
  });
});

describe('groupDependencies — teamId and repoFullName', () => {
  it('propagates teamId and repoFullName to all groups', () => {
    const groups = groupDependencies(MIXED_DEPS, 'team-bravo', 'nanohype/service-x', {
      groupingStrategy: 'per-dep',
      groupingFamilies: {},
    });

    for (const g of groups) {
      expect(g.teamId).toBe('team-bravo');
      expect(g.repoFullName).toBe('nanohype/service-x');
    }
  });
});

describe('groupDependencies — empty deps list', () => {
  it('returns an empty array for all strategies', () => {
    for (const strategy of ['per-dep', 'per-family', 'per-release-window'] as const) {
      const groups = groupDependencies([], 'team-a', 'org/repo', {
        groupingStrategy: strategy,
        groupingFamilies: {},
      });
      // per-release-window with empty deps → 1 group with 0 deps
      if (strategy === 'per-release-window') {
        expect(groups[0]!.dependencies).toHaveLength(0);
      } else {
        expect(groups).toHaveLength(0);
      }
    }
  });
});

describe('findFamilyGroup', () => {
  const families = {
    '^@aws-sdk/': 'aws-sdk',
    '^@types/': 'types',
    '^react': 'react-family',
  };

  it('matches a scoped package to its family group', () => {
    expect(findFamilyGroup('@aws-sdk/client-s3', families)).toBe('aws-sdk');
    expect(findFamilyGroup('@types/node', families)).toBe('types');
  });

  it('matches first pattern (order of Object.entries)', () => {
    // 'react' and 'react-dom' both match '^react'
    expect(findFamilyGroup('react', families)).toBe('react-family');
    expect(findFamilyGroup('react-dom', families)).toBe('react-family');
  });

  it('returns null when no pattern matches', () => {
    expect(findFamilyGroup('lodash', families)).toBeNull();
    expect(findFamilyGroup('prisma', families)).toBeNull();
  });

  it('ignores malformed regex patterns gracefully', () => {
    const badFamilies = { '[invalid': 'bad-group', '^react': 'react' };
    expect(() => findFamilyGroup('react', badFamilies)).not.toThrow();
    expect(findFamilyGroup('react', badFamilies)).toBe('react');
  });
});
