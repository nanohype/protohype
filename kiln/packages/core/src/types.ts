/** Per-call timeout constants (ms) — all external clients must use these. */
export const TIMEOUTS = {
  NPM_REGISTRY: 10_000,
  CHANGELOG_FETCH: 10_000,
  BEDROCK: 30_000,
  GITHUB_READ: 5_000,
  GITHUB_WRITE: 15_000,
} as const;

export type GroupingStrategy = 'per-dep' | 'per-family' | 'per-release-window';

export interface TeamConfig {
  teamId: string;
  repos: string[];
  targetVersionPolicy: 'latest' | 'latest-minor' | 'latest-patch';
  /** Review SLA in hours. */
  reviewSla: number;
  slackChannel: string;
  /** Dependency names to skip upgrading. */
  pinnedSkipList: string[];
  groupingStrategy: GroupingStrategy;
  /**
   * Maps a regex pattern (string) to a group name.
   * Matches the shape of Renovate's groupName config.
   * Example: { "^@aws-sdk/": "aws-sdk" }
   */
  groupingFamilies: Record<string, string>;
  /** Cron expression for release-window grouping. Optional. */
  releaseWindowCron?: string;
}

export interface DepVersion {
  name: string;
  currentVersion: string;
  latestVersion: string;
  /** Changelog URL — must be in domain allowlist. */
  changelogUrl?: string;
}

export interface BreakingChange {
  description: string;
  /** File where this breaking change was detected. */
  file?: string;
  /** 1-based line number. */
  line?: number;
  requiresHumanReview: boolean;
}

export interface PatchResult {
  file: string;
  /** 1-based line number where the patch was applied. */
  originalLine: number;
  originalCode: string;
  patchedCode: string;
}

export interface MigrationNote {
  dependency: string;
  fromVersion: string;
  toVersion: string;
  /** At least one changelog URL is required per production bar. */
  changelogUrl: string;
  breakingChanges: BreakingChange[];
  patches: PatchResult[];
  humanReviewRequired: boolean;
}

export interface UpgradeGroup {
  groupName: string;
  dependencies: DepVersion[];
  strategy: GroupingStrategy;
  teamId: string;
  repoFullName: string;
}
