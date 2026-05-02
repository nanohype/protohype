// Fakes for unit + integration tests. One module — one place to reach for
// a test double. Each fake implements the real port interface; none touch
// AWS.

import type {
  AuditLogPort,
  ChangelogCachePort,
  ChangelogFetcherPort,
  ClassifyInput,
  ClassifyOutput,
  CodeSearchPort,
  GithubAppPort,
  IdentityPort,
  LlmPort,
  LoggerPort,
  NotificationsPort,
  NpmRegistryPort,
  PrLedgerPort,
  PrRecord,
  RateLimiterPort,
  SecretsPort,
  SynthesizeInput,
  SynthesizeOutput,
  TeamConfigPort,
  UpgradeQueuePort,
} from "../src/core/ports.js";
import type { ClockPort, Ports } from "../src/core/ports.js";
import {
  asTeamId,
  err,
  ok,
  type AuditRecord,
  type AuditStatus,
  type CallSite,
  type InstallationId,
  type PrIdempotencyKey,
  type PrRef,
  type Result,
  type TeamConfig,
  type TeamId,
  type UpgradeId,
  type UpgradeJob,
} from "../src/types.js";
import { idempotencyDigest } from "../src/core/github/idempotency.js";

export class FakeClock implements ClockPort {
  constructor(private current: Date = new Date("2026-04-20T00:00:00Z")) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export function silentLogger(): LoggerPort {
  const noop = (): void => undefined;
  const self: LoggerPort = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => self,
  };
  return self;
}

export class InMemoryTeamConfigPort implements TeamConfigPort {
  private byId = new Map<string, TeamConfig>();

  async get(teamId: TeamId): Promise<Result<TeamConfig | null>> {
    return Promise.resolve(ok(this.byId.get(teamId) ?? null));
  }
  async put(cfg: TeamConfig): Promise<Result<void>> {
    this.byId.set(cfg.teamId, cfg);
    return Promise.resolve(ok(undefined));
  }
  async delete(teamId: TeamId): Promise<Result<void>> {
    this.byId.delete(teamId);
    return Promise.resolve(ok(undefined));
  }
  async list(): Promise<Result<TeamConfig[]>> {
    return Promise.resolve(ok([...this.byId.values()]));
  }
}

export class InMemoryPrLedgerPort implements PrLedgerPort {
  private byKey = new Map<string, PrRecord>();

  async recordPrOpened(
    key: PrIdempotencyKey,
    pr: PrRef,
    upgradeId: UpgradeId,
  ): Promise<Result<void>> {
    const digest = idempotencyDigest(key);
    if (this.byKey.has(digest)) return Promise.resolve(err({ kind: "Conflict", message: "dup" }));
    this.byKey.set(digest, { teamId: key.teamId, upgradeId, key, pr, openedAt: new Date().toISOString() });
    return Promise.resolve(ok(undefined));
  }
  async findExistingPr(key: PrIdempotencyKey): Promise<Result<PrRef | null>> {
    return Promise.resolve(ok(this.byKey.get(idempotencyDigest(key))?.pr ?? null));
  }
  async listRecent(teamId: TeamId, limit: number): Promise<Result<PrRecord[]>> {
    const items = [...this.byKey.values()].filter((r) => r.teamId === teamId).slice(0, limit);
    return Promise.resolve(ok(items));
  }
}

export class InMemoryAuditLogPort implements AuditLogPort {
  public written: AuditRecord[] = [];
  async putUpgradeRecord(rec: AuditRecord): Promise<Result<void>> {
    this.written.push({ ...rec });
    return Promise.resolve(ok(undefined));
  }
  async updateUpgradeStatus(
    _teamId: TeamId,
    _upgradeId: UpgradeId,
    _status: AuditStatus,
    _patch?: Partial<AuditRecord>,
  ): Promise<Result<void>> {
    return Promise.resolve(ok(undefined));
  }
}

export class InMemoryChangelogCachePort implements ChangelogCachePort {
  private store = new Map<string, { body: string; fetchedAt: string }>();
  async get(cacheKey: string): Promise<{ body: string; fetchedAt: string } | null> {
    return Promise.resolve(this.store.get(cacheKey) ?? null);
  }
  async put(cacheKey: string, body: string, _ttlSeconds: number): Promise<void> {
    this.store.set(cacheKey, { body, fetchedAt: new Date().toISOString() });
    return Promise.resolve();
  }
}

export class InMemoryRateLimiterPort implements RateLimiterPort {
  private buckets = new Map<string, number>();
  async tryAcquire(bucketKey: string, capacity: number, _refillPerSec: number): Promise<boolean> {
    const current = this.buckets.get(bucketKey) ?? capacity;
    if (current < 1) return Promise.resolve(false);
    this.buckets.set(bucketKey, current - 1);
    return Promise.resolve(true);
  }
}

export class StaticNpmRegistryPort implements NpmRegistryPort {
  constructor(
    private latest: Record<string, { version: string; publishedAt: string }> = {},
    private manifests: Record<string, { repository?: string; homepage?: string }> = {},
  ) {}
  async getLatestVersion(pkg: string) {
    const v = this.latest[pkg];
    return Promise.resolve(v ? ok(v) : err({ kind: "NotFound" as const, what: `npm:${pkg}` }));
  }
  async getVersionManifest(pkg: string, _v: string) {
    const m = this.manifests[pkg];
    return Promise.resolve(m ? ok(m) : err({ kind: "NotFound" as const, what: `npm:${pkg}` }));
  }
}

export class StaticChangelogFetcher implements ChangelogFetcherPort {
  constructor(private bodies: Record<string, string> = {}) {}
  async fetch(url: string) {
    const body = this.bodies[url];
    return Promise.resolve(body ? ok({ body }) : ok(null));
  }
}

export class StaticCodeSearchPort implements CodeSearchPort {
  constructor(private sites: CallSite[] = []) {}
  async searchImportSites(
    _id: InstallationId,
    _o: string,
    _r: string,
    _pkg: string,
    symbols: string[],
  ) {
    const filtered = this.sites.filter((s) => symbols.length === 0 || symbols.includes(s.symbol));
    return Promise.resolve(ok(filtered));
  }
}

export class StaticLlmPort implements LlmPort {
  constructor(
    private classifyResp: ClassifyOutput,
    private synthesizeResp: SynthesizeOutput,
  ) {}
  async classify(_: ClassifyInput) {
    return Promise.resolve(ok(this.classifyResp));
  }
  async synthesize(_: SynthesizeInput) {
    return Promise.resolve(ok(this.synthesizeResp));
  }
}

export class StaticGithubAppPort implements GithubAppPort {
  constructor(private opened: PrRef) {}
  async getInstallationToken(_: InstallationId) {
    return Promise.resolve(ok({ token: "fake", expiresAt: new Date(Date.now() + 60 * 60 * 1000) }));
  }
  async getFile(_i: InstallationId, _o: string, _r: string, _p: string, _ref: string) {
    return Promise.resolve(ok({ sha: "deadbeef", content: "" }));
  }
  async headSha(_i: InstallationId, _o: string, _r: string, _ref: string) {
    return Promise.resolve(ok("deadbeef"));
  }
  async openPullRequest(_: InstallationId) {
    return Promise.resolve(ok(this.opened));
  }
}

export class InMemoryUpgradeQueue implements UpgradeQueuePort {
  public enqueued: UpgradeJob[] = [];
  async enqueue(job: UpgradeJob) {
    this.enqueued.push(job);
    return Promise.resolve(ok(undefined));
  }
}

export class StaticIdentityPort implements IdentityPort {
  constructor(private teamId: string) {}
  async verifyBearer(_: string) {
    return Promise.resolve(
      ok({
        teamId: asTeamId(this.teamId),
        userId: "user-1",
        scopes: [],
        issuer: "https://test.invalid",
        audience: "api://kiln",
      }),
    );
  }
}

export class StaticSecretsPort implements SecretsPort {
  constructor(private values: Record<string, string> = {}) {}
  async getString(arn: string) {
    const v = this.values[arn];
    return Promise.resolve(v ? ok(v) : err({ kind: "NotFound" as const, what: arn }));
  }
}

export class StaticNotificationsPort implements NotificationsPort {
  async postPrOpened() {
    return Promise.resolve(ok(undefined));
  }
  async postFailure() {
    return Promise.resolve(ok(undefined));
  }
}

export function buildFakePorts(overrides: Partial<Ports> = {}): Ports {
  const classifyResp: ClassifyOutput = {
    breakingChanges: [],
    summary: "no breaking changes",
    confidence: 1,
  };
  const synthesizeResp: SynthesizeOutput = { patches: [], notes: "", warnings: [] };
  const prRef: PrRef = {
    owner: "acme",
    repo: "app",
    number: 1,
    url: "https://github.com/acme/app/pull/1",
    headSha: "sha",
  };
  const base: Ports = {
    npm: new StaticNpmRegistryPort(),
    changelog: new StaticChangelogFetcher(),
    changelogCache: new InMemoryChangelogCachePort(),
    teamConfig: new InMemoryTeamConfigPort(),
    prLedger: new InMemoryPrLedgerPort(),
    audit: new InMemoryAuditLogPort(),
    rate: new InMemoryRateLimiterPort(),
    llm: new StaticLlmPort(classifyResp, synthesizeResp),
    codeSearch: new StaticCodeSearchPort(),
    github: new StaticGithubAppPort(prRef),
    queue: new InMemoryUpgradeQueue(),
    identity: new StaticIdentityPort("team-test"),
    secrets: new StaticSecretsPort(),
    notifications: new StaticNotificationsPort(),
    clock: new FakeClock(),
    logger: silentLogger(),
  };
  return { ...base, ...overrides };
}
