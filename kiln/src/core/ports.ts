// Ports — the architectural seam between pure domain and infrastructure.
//
// Every side effect kiln performs flows through a port. Adapters under
// src/adapters/ implement these interfaces; workers and api/ depend on the
// interface, never on the implementation. Tests provide fakes.
//
// Naming rule: every port method that touches tenant state takes a TeamId.
// That makes cross-tenant reads a type error, not a missed runtime check.

import type {
  AuditRecord,
  AuditStatus,
  BreakingChange,
  CallSite,
  FilePatch,
  InstallationId,
  PrIdempotencyKey,
  PrRef,
  PrSpec,
  Result,
  TeamConfig,
  TeamId,
  UpgradeId,
  UpgradeJob,
  VerifiedIdentity,
} from "../types.js";

// ── Npm ─────────────────────────────────────────────────────────────────────
export interface NpmRegistryPort {
  getLatestVersion(pkg: string): Promise<Result<{ version: string; publishedAt: string }>>;
  getVersionManifest(
    pkg: string,
    version: string,
  ): Promise<Result<{ repository?: string; homepage?: string }>>;
}

// ── Changelog (fetch is the adapter; parsing is pure in core) ──────────────
export interface ChangelogFetcherPort {
  fetch(url: string): Promise<Result<{ body: string; etag?: string } | null>>;
}

export interface ChangelogCachePort {
  get(cacheKey: string): Promise<{ body: string; fetchedAt: string } | null>;
  put(cacheKey: string, body: string, ttlSeconds: number): Promise<void>;
}

// ── Team config ────────────────────────────────────────────────────────────
export interface TeamConfigPort {
  get(teamId: TeamId): Promise<Result<TeamConfig | null>>;
  put(cfg: TeamConfig): Promise<Result<void>>;
  delete(teamId: TeamId): Promise<Result<void>>;
  // list() is only usable by the poller; IAM scopes this to the poller role.
  list(): Promise<Result<TeamConfig[]>>;
}

// ── PR ledger ──────────────────────────────────────────────────────────────
export interface PrLedgerPort {
  recordPrOpened(key: PrIdempotencyKey, pr: PrRef, upgradeId: UpgradeId): Promise<Result<void>>;
  findExistingPr(key: PrIdempotencyKey): Promise<Result<PrRef | null>>;
  listRecent(teamId: TeamId, limit: number): Promise<Result<PrRecord[]>>;
}

export interface PrRecord {
  teamId: TeamId;
  upgradeId: UpgradeId;
  key: PrIdempotencyKey;
  pr: PrRef;
  openedAt: string;
}

// ── Audit ──────────────────────────────────────────────────────────────────
// Every pipeline step writes to audit. Puts are awaited, never fire-and-forget.
export interface AuditLogPort {
  putUpgradeRecord(rec: AuditRecord): Promise<Result<void>>;
  updateUpgradeStatus(
    teamId: TeamId,
    upgradeId: UpgradeId,
    status: AuditStatus,
    patch?: Partial<AuditRecord>,
  ): Promise<Result<void>>;
}

// ── Rate limiter (DDB-backed token bucket, shared across Lambda instances) ─
export interface RateLimiterPort {
  // Conditional UpdateItem — returns true iff a token was taken.
  tryAcquire(bucketKey: string, capacity: number, refillPerSec: number): Promise<boolean>;
}

// ── LLM (Bedrock) ──────────────────────────────────────────────────────────
export interface ClassifyInput {
  pkg: string;
  fromVersion: string;
  toVersion: string;
  changelogBody: string;
}

export interface ClassifyOutput {
  breakingChanges: BreakingChange[];
  summary: string;
  confidence: number;
}

export interface SynthesizeInput {
  pkg: string;
  fromVersion: string;
  toVersion: string;
  breakingChange: BreakingChange;
  callSites: CallSite[];
}

export interface SynthesizeOutput {
  patches: FilePatch[];
  notes: string;
  warnings: string[];
}

export type LlmModel = "classifier" | "synthesizer" | "synthesizer-escalation";

export interface LlmPort {
  classify(input: ClassifyInput): Promise<Result<ClassifyOutput>>;
  synthesize(input: SynthesizeInput, model: LlmModel): Promise<Result<SynthesizeOutput>>;
}

// ── Codebase scan (GitHub code search) ─────────────────────────────────────
export interface CodeSearchPort {
  searchImportSites(
    installationId: InstallationId,
    owner: string,
    repo: string,
    pkg: string,
    symbols: string[],
  ): Promise<Result<CallSite[]>>;
}

// ── GitHub App (PRs + file ops) ────────────────────────────────────────────
export interface GithubAppPort {
  getInstallationToken(id: InstallationId): Promise<Result<{ token: string; expiresAt: Date }>>;
  getFile(
    installationId: InstallationId,
    owner: string,
    repo: string,
    path: string,
    ref: string,
  ): Promise<Result<{ sha: string; content: string }>>;
  headSha(
    installationId: InstallationId,
    owner: string,
    repo: string,
    ref: string,
  ): Promise<Result<string>>;
  openPullRequest(installationId: InstallationId, spec: PrSpec): Promise<Result<PrRef>>;
}

// ── Upgrade queue (SQS FIFO) ───────────────────────────────────────────────
export interface UpgradeQueuePort {
  enqueue(job: UpgradeJob): Promise<Result<void>>;
}

// ── Identity (WorkOS JWKS verify) ──────────────────────────────────────────
export interface IdentityPort {
  verifyBearer(bearer: string): Promise<Result<VerifiedIdentity>>;
}

// ── Secrets ────────────────────────────────────────────────────────────────
export interface SecretsPort {
  // Returns cached value if fresh; re-fetches on TTL or version miss.
  getString(arn: string): Promise<Result<string>>;
}

// ── Notifications ──────────────────────────────────────────────────────────
export interface NotificationsPort {
  postPrOpened(channel: string, teamId: TeamId, pr: PrRef, summary: string): Promise<Result<void>>;
  postFailure(channel: string, teamId: TeamId, message: string): Promise<Result<void>>;
}

// ── Trivia ─────────────────────────────────────────────────────────────────
export interface ClockPort {
  now(): Date;
}

export interface LoggerPort {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): LoggerPort;
}

// ── Composition root ───────────────────────────────────────────────────────
export interface Ports {
  npm: NpmRegistryPort;
  changelog: ChangelogFetcherPort;
  changelogCache: ChangelogCachePort;
  teamConfig: TeamConfigPort;
  prLedger: PrLedgerPort;
  audit: AuditLogPort;
  rate: RateLimiterPort;
  llm: LlmPort;
  codeSearch: CodeSearchPort;
  github: GithubAppPort;
  queue: UpgradeQueuePort;
  identity: IdentityPort;
  secrets: SecretsPort;
  notifications: NotificationsPort;
  clock: ClockPort;
  logger: LoggerPort;
}
