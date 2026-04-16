import { resolveGroupKey, groupPackages, buildBranchName } from '../lambda/upgrade-worker/grouper';
import type { GroupingStrategy } from '../lambda/shared/types';

describe('resolveGroupKey', () => {
  describe('per-dep strategy', () => {
    const strategy: GroupingStrategy = { strategy: 'per-dep' };

    it('uses sanitised package name', () => {
      expect(resolveGroupKey('react', strategy)).toBe('react');
    });

    it('sanitises scoped package names', () => {
      const key = resolveGroupKey('@aws-sdk/client-dynamodb', strategy);
      expect(key).toMatch(/^[a-z0-9._-]+$/);
      expect(key).not.toContain('@');
    });

    it('sanitises slashes in scoped names', () => {
      const key = resolveGroupKey('@types/node', strategy);
      expect(key).not.toContain('/');
    });
  });

  describe('per-family strategy', () => {
    const strategy: GroupingStrategy = {
      strategy: 'per-family',
      families: ['@aws-sdk/*', '@types/*'],
    };

    it('groups @aws-sdk/* packages together', () => {
      const k1 = resolveGroupKey('@aws-sdk/client-dynamodb', strategy);
      const k2 = resolveGroupKey('@aws-sdk/client-s3', strategy);
      expect(k1).toBe(k2);
    });

    it('groups @types/* packages together', () => {
      const k1 = resolveGroupKey('@types/node', strategy);
      const k2 = resolveGroupKey('@types/react', strategy);
      expect(k1).toBe(k2);
    });

    it('@aws-sdk and @types groups are different', () => {
      const k1 = resolveGroupKey('@aws-sdk/client-dynamodb', strategy);
      const k2 = resolveGroupKey('@types/node', strategy);
      expect(k1).not.toBe(k2);
    });

    it('falls back to per-dep for unmatched packages', () => {
      const key = resolveGroupKey('react', strategy);
      expect(key).toBe('react');
    });
  });

  describe('per-release-window strategy', () => {
    const strategy: GroupingStrategy = {
      strategy: 'per-release-window',
      windowHours: 24,
    };

    it('produces window- prefixed key', () => {
      const key = resolveGroupKey('react', strategy);
      expect(key).toMatch(/^window-/);
    });

    it('all packages in same invocation get same key', () => {
      const k1 = resolveGroupKey('react', strategy);
      const k2 = resolveGroupKey('@aws-sdk/client-s3', strategy);
      expect(k1).toBe(k2);
    });
  });
});

describe('groupPackages', () => {
  it('groups @aws-sdk/* packages into one group', () => {
    const pkgs = ['@aws-sdk/client-dynamodb', '@aws-sdk/client-s3', 'react'];
    const strategy: GroupingStrategy = {
      strategy: 'per-family',
      families: ['@aws-sdk/*'],
    };
    const groups = groupPackages(pkgs, strategy);
    let awsGroup: string[] = [];
    for (const [, val] of groups) {
      if (val.includes('@aws-sdk/client-dynamodb')) {
        awsGroup = val;
        break;
      }
    }
    expect(awsGroup).toContain('@aws-sdk/client-dynamodb');
    expect(awsGroup).toContain('@aws-sdk/client-s3');
    expect(awsGroup).not.toContain('react');
  });
});

describe('buildBranchName', () => {
  it('produces a feat/kiln- prefixed branch name', () => {
    const name = buildBranchName('react', '18.3.0');
    expect(name).toMatch(/^feat\/kiln-/);
  });

  it('sanitises @ characters from scoped packages', () => {
    const name = buildBranchName('@aws-sdk/client-s3', '3.0.0');
    expect(name).not.toContain('@');
  });

  it('includes the version', () => {
    const name = buildBranchName('react', '18.3.0');
    expect(name).toContain('18.3.0');
  });

  it('produces valid branch name format', () => {
    // Git branch names can contain / but not certain special chars
    const name = buildBranchName('@aws-sdk/client-dynamodb', '3.100.0');
    // Should only contain allowed chars after feat/kiln- prefix
    expect(name).toMatch(/^feat\/kiln-[a-z0-9._/-]+$/);
  });
});
