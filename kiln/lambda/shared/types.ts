/**
 * Kiln — shared domain types.
 *
 * All cross-Lambda types live here. Discriminated unions drive state;
 * no boolean flags that change a shape's meaning.
 */

// ─── Grouping strategy ───────────────────────────────────────────────────────

/** One PR per individual dependency. */
export interface PerDepGrouping {
  strategy: 'per-dep';
}

/**
 * One PR per package family, identified by a glob prefix.
 * e.g. `@aws-sdk/*` or `@types/*`.
 */
export interface PerFamilyGrouping {
  strategy: 'per-family';
  /** Glob prefix patterns. A dep matches if its name starts with any prefix. */
  families: string[];
}

/**
 * One PR per configured time window.
 * All new versions published within the window are batched.
 */
export interface PerWindowGrouping {
  strategy: 'per-release-window';
  /** Window size in hours (e.g. 24 = daily batch). */
  windowHours: number;
}

export type GroupingStrategy = PerDepGrouping | PerFamilyGrouping | PerWindowGrouping;

// ─── Team configuration ───────────────────────────────────────────────────────

/** Target-version policy for a watched package. */
export type TargetVersionPolicy =
  | 'latest'         // always target the latest published version
  | 'next-minor'     // stay within the current major, pick latest minor
  | 'next-patch';    // stay within the current major.minor, pick latest patch

export interface WatchedPackage {
  name: string;
  policy: TargetVersionPolicy;
  /** Explicit versions to skip (e.g. known-bad releases). */
  skipVersions?: string[];
}

export interface TeamConfig {
  teamId: string;
  /** GitHub org/owner the team's repos live under. */
  githubOrg: string;
  /** Repository names within githubOrg to watch. */
  watchedRepos: string[];
  watchedPackages: WatchedPackage[];
  grouping: GroupingStrategy;
  /** Slack channel ID for notifications (e.g. C0123ABCD). */
  slackChannelId?: string;
  /** Linear team ID for filing human-judgment issues. */
  linearTeamId?: string;
  /** Review SLA in hours (Kiln notifies if PR is not reviewed within this window). */
  reviewSlaHours: number;
  /** Kiln will not open PRs to repos listed here. */
  pinnedSkipRepos?: string[];
  createdAt: string;   // ISO 8601
  updatedAt: string;   // ISO 8601
}

// ─── Upgrade job (SQS payload) ────────────────────────────────────────────────

export interface UpgradeJob {
  jobId: string;
  teamId: string;
  githubOrg: string;
  repo: string;
  packageName: string;
  fromVersion: string;
  toVersion: string;
  changelogUrl: string;
  groupKey: string;       // derived from grouping strategy
  groupStrategy: GroupingStrategy;
  enqueuedAt: string;     // ISO 8601
}

// ─── Changelog analysis ───────────────────────────────────────────────────────

/** A single breaking change extracted from the vendor changelog. */
export interface BreakingChange {
  description: string;
  /** The changelog URL that documents this breaking change. */
  sourceUrl: string;
  /** API surface that changed, e.g. "DynamoDB.putItem signature". */
  apiSurface?: string;
  /** Migration instruction synthesised by Bedrock. */
  migration?: string;
}

/** Haiku classification result. */
export type ChangelogClassification =
  | { hasBreakingChanges: true; breakingChanges: BreakingChange[] }
  | { hasBreakingChanges: false };

// ─── Code usage & patches ─────────────────────────────────────────────────────

export interface CodeUsage {
  file: string;
  /** 1-based line numbers where the breaking API is used. */
  lines: number[];
  /** Raw code excerpt around the usage site. */
  excerpt: string;
}

/** A single mechanical patch to apply. */
export interface CodePatch {
  file: string;
  /** 1-based start line of the region to replace. */
  startLine: number;
  /** 1-based end line of the region to replace. */
  endLine: number;
  /** Original content (for verification). */
  original: string;
  /** Replacement content. */
  replacement: string;
  /** Breaking change this patch addresses. */
  breakingChangeDescription: string;
}

/** Synthesised migration for a single breaking change in a repo. */
export type MigrationResult =
  | {
      kind: 'patched';
      change: BreakingChange;
      usages: CodeUsage[];
      patches: CodePatch[];
    }
  | {
      kind: 'human-review';
      change: BreakingChange;
      usages: CodeUsage[];
      reason: string;   // why mechanical patching is not possible
    }
  | {
      kind: 'no-usage';
      change: BreakingChange;
    };

// ─── PR authoring ledger ──────────────────────────────────────────────────────

export type PrStatus =
  | 'pending'     // job in queue
  | 'in-progress' // worker running
  | 'opened'      // PR created on GitHub
  | 'merged'      // PR merged
  | 'closed'      // PR closed without merging
  | 'failed';     // worker failed

export interface PrLedgerEntry {
  teamId: string;
  prId: string;    // SK: `{groupKey}#{toVersion}`
  groupKey: string;
  packageName: string;
  fromVersion: string;
  toVersion: string;
  repo: string;
  githubPrNumber?: number;
  githubPrUrl?: string;
  status: PrStatus;
  migrations: MigrationResult[];
  changelogUrls: string[];
  createdAt: string;
  updatedAt: string;
}

// ─── Audit log ────────────────────────────────────────────────────────────────

export type AuditAction =
  | 'config.created'
  | 'config.updated'
  | 'config.deleted'
  | 'config.read'
  | 'pr.opened'
  | 'pr.status.updated'
  | 'changelog.fetched'
  | 'upgrade.enqueued'
  | 'upgrade.started'
  | 'upgrade.completed'
  | 'upgrade.failed';

export interface AuditEvent {
  teamId: string;
  eventId: string;    // SK: `{timestamp}#{uuid}`
  action: AuditAction;
  actorIdentity: string;   // Okta subject claim — never fabricated
  metadata: Record<string, unknown>;
  createdAt: string;
  /** TTL for DynamoDB expiry (Unix seconds). Kiln keeps 1 year = 365 days. */
  expiresAt: number;
}

// ─── GitHub App ───────────────────────────────────────────────────────────────

export interface GitHubAppInstallation {
  installationId: number;
  appId: number;
  /** Installation-scoped token — expires in 1 hour. */
  token: string;
  expiresAt: string;  // ISO 8601
}

// ─── API response shapes ──────────────────────────────────────────────────────

export interface ApiError {
  error: string;
  message: string;
  requestId?: string;
}

export interface ApiOk<T> {
  data: T;
  requestId?: string;
}
