/**
 * Core domain types for Kiln — dependency upgrade automation service.
 */

// ── Team configuration ───────────────────────────────────────────────────────

export type GroupingStrategy =
  | { kind: "per-dep" }
  | { kind: "per-family"; pattern: string } // e.g. "@aws-sdk/*"
  | { kind: "per-release-window"; windowDays: number };

export interface TeamConfig {
  teamId: string;
  orgId: string;
  repos: RepoConfig[];
  targetVersionPolicy: "latest" | "minor-only" | "patch-only";
  reviewSlaDays: number;
  slackChannel: string | null;
  linearProjectId: string | null;
  groupingStrategy: GroupingStrategy;
  pinnedSkipList: string[]; // dep names to never upgrade
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
}

export interface RepoConfig {
  owner: string;
  repo: string;
  installationId: number;
  watchedDeps: string[]; // top-level dep names to watch
  defaultBranch: string;
}

// ── Upgrade lifecycle ─────────────────────────────────────────────────────────

export type UpgradeStatus =
  | "pending"
  | "changelog-fetched"
  | "analyzed"
  | "patched"
  | "pr-opened"
  | "merged"
  | "failed"
  | "skipped";

export interface UpgradeRecord {
  upgradeId: string;
  teamId: string;
  owner: string;
  repo: string;
  dep: string;
  fromVersion: string;
  toVersion: string;
  groupId: string | null; // non-null when grouped
  status: UpgradeStatus;
  prNumber: number | null;
  prUrl: string | null;
  changelogUrls: string[];
  breakingChanges: BreakingChange[];
  patchedFiles: PatchedFile[];
  humanReviewItems: HumanReviewItem[];
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BreakingChange {
  description: string;
  category: "api-removal" | "api-rename" | "signature-change" | "behavior-change" | "other";
  affectedSymbol: string | null;
}

export interface PatchedFile {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  originalCode: string;
  patchedCode: string;
  breakingChangeDescription: string;
}

export interface HumanReviewItem {
  filePath: string;
  line: number;
  reason: string;
  suggestion: string | null;
}

// ── Changelog cache ───────────────────────────────────────────────────────────

export interface ChangelogEntry {
  dep: string;
  version: string;
  fetchedAt: string;
  sourceUrl: string;
  rawContent: string;
  breakingChanges: BreakingChange[];
  expiresAt: number; // unix seconds TTL
}

// ── GitHub App ────────────────────────────────────────────────────────────────

export interface GitHubAppSecret {
  appId: string;
  privateKey: string; // PEM — loaded from Secrets Manager
  webhookSecret: string;
}

export interface InstallationToken {
  token: string;
  expiresAt: string; // ISO-8601
  installationId: number;
}

// ── Rate limit state ──────────────────────────────────────────────────────────

export interface RateLimitBucket {
  key: string; // "github-api"
  tokens: number;
  lastRefillAt: number; // unix ms
}

// ── API request / response shapes ────────────────────────────────────────────

export interface CreateTeamConfigRequest {
  orgId: string;
  repos: RepoConfig[];
  targetVersionPolicy?: TeamConfig["targetVersionPolicy"];
  reviewSlaDays?: number;
  slackChannel?: string;
  linearProjectId?: string;
  groupingStrategy?: GroupingStrategy;
  pinnedSkipList?: string[];
}

export interface TriggerUpgradeRequest {
  owner: string;
  repo: string;
  dep: string;
  toVersion: string;
}

export interface UpgradeSummary {
  upgradeId: string;
  dep: string;
  fromVersion: string;
  toVersion: string;
  status: UpgradeStatus;
  prUrl: string | null;
  breakingChangesCount: number;
  patchedFilesCount: number;
  humanReviewItemsCount: number;
  createdAt: string;
}

// ── Bedrock payloads ──────────────────────────────────────────────────────────

export interface ChangelogClassificationRequest {
  dep: string;
  fromVersion: string;
  toVersion: string;
  rawChangelog: string;
}

export interface ChangelogClassificationResult {
  hasBreakingChanges: boolean;
  breakingChanges: BreakingChange[];
  changelogUrls: string[];
}

export interface MigrationSynthesisRequest {
  dep: string;
  fromVersion: string;
  toVersion: string;
  breakingChanges: BreakingChange[];
  usageSites: UsageSite[];
}

export interface UsageSite {
  filePath: string;
  lineNumber: number;
  lineContent: string;
  symbol: string;
}

export interface MigrationSynthesisResult {
  patches: ProposedPatch[];
  humanReviewItems: HumanReviewItem[];
}

export interface ProposedPatch {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  originalCode: string;
  patchedCode: string;
  breakingChangeDescription: string;
  confidence: "high" | "medium" | "low";
}

// ── Okta identity ─────────────────────────────────────────────────────────────

export interface OktaIdentity {
  sub: string; // Okta user ID
  email: string;
  groups: string[]; // Okta group memberships (drives teamId ACLs)
  teamIds: string[]; // derived from groups via convention kiln-team-<teamId>
}
