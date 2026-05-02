// Branded ("nominal") ids. Constructing a TeamId requires going through the
// identity verification path — cross-tenant reads become compile errors, not
// runtime bugs waiting to happen.
export type TeamId = string & { readonly __brand: "TeamId" };
export type UpgradeId = string & { readonly __brand: "UpgradeId" };
export type InstallationId = number & { readonly __brand: "InstallationId" };

export const asTeamId = (s: string): TeamId => s as TeamId;
export const asUpgradeId = (s: string): UpgradeId => s as UpgradeId;
export const asInstallationId = (n: number): InstallationId => n as InstallationId;

// ── Team configuration ──────────────────────────────────────────────────────
export type TargetVersionPolicy = "latest" | "minor-only" | "patch-only";

export type GroupingStrategy =
  | { kind: "per-dep" }
  | { kind: "per-family"; pattern: string }
  | { kind: "per-release-window"; windowDays: number };

export interface RepoConfig {
  owner: string;
  repo: string;
  installationId: InstallationId;
  watchedDeps: string[];
}

export interface TeamConfig {
  teamId: TeamId;
  orgId: string;
  repos: RepoConfig[];
  targetVersionPolicy: TargetVersionPolicy;
  reviewSlaDays: number;
  slackChannel: string | null;
  linearProjectId: string | null;
  groupingStrategy: GroupingStrategy;
  pinnedSkipList: string[];
  createdAt: string;
  updatedAt: string;
}

// ── Upgrade pipeline ────────────────────────────────────────────────────────
export interface UpgradeJob {
  teamId: TeamId;
  upgradeId: UpgradeId;
  repo: { owner: string; name: string; installationId: InstallationId };
  pkg: string;
  fromVersion: string;
  toVersion: string;
  enqueuedAt: string;
  groupKey: string; // canonical groupId for ordering
}

export interface BreakingChange {
  id: string;
  title: string;
  severity: "breaking" | "deprecation" | "behavior-change";
  description: string;
  affectedSymbols: string[];
  changelogUrl: string;
}

export interface CallSite {
  repo: string;
  path: string;
  line: number;
  symbol: string;
  snippet: string;
}

export interface FilePatch {
  path: string;
  before: string;
  after: string;
  citations: string[]; // changelog URLs + file:line refs
}

export interface PrSpec {
  owner: string;
  repo: string;
  baseBranch: string;
  headBranch: string;
  title: string;
  body: string;
  files: FilePatch[];
}

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
  url: string;
  headSha: string;
}

// ── Audit ───────────────────────────────────────────────────────────────────
export type AuditStatus =
  | "pending"
  | "classifying"
  | "scanning"
  | "synthesizing"
  | "pr-opened"
  | "failed"
  | "skipped";

export interface AuditRecord {
  teamId: TeamId;
  upgradeId: UpgradeId;
  pkg: string;
  fromVersion: string;
  toVersion: string;
  status: AuditStatus;
  startedAt: string;
  finishedAt?: string;
  prRef?: PrRef;
  errorMessage?: string;
  modelsUsed?: { classifier?: string; synthesizer?: string };
}

// ── Identity (from WorkOS JWT verification) ────────────────────────────────
export interface VerifiedIdentity {
  teamId: TeamId;
  userId: string;
  email?: string;
  scopes: string[];
  issuer: string;
  audience: string;
}

// ── Result — errors-as-values at adapter boundaries ────────────────────────
export type Result<T, E = DomainError> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export type DomainError =
  | { kind: "NotFound"; what: string }
  | { kind: "Validation"; message: string; path?: string }
  | { kind: "Upstream"; source: string; status?: number; message: string }
  | { kind: "Timeout"; source: string; timeoutMs: number }
  | { kind: "RateLimited"; source: string; retryAfterMs?: number }
  | { kind: "Forbidden"; source: string; message: string }
  | { kind: "Conflict"; message: string }
  | { kind: "Internal"; message: string; cause?: unknown };

// ── Idempotency key (SQS message-dedupe + PR ledger key) ───────────────────
export interface PrIdempotencyKey {
  teamId: TeamId;
  repo: string;
  pkg: string;
  fromVersion: string;
  toVersion: string;
}
