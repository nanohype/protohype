// End-to-end pipeline: runUpgrader against a Ports bundle where the DB layer
// is real (DynamoDB Local) and external services are fakes. Proves:
//   - audit record is written at every stage
//   - PR ledger records the outcome
//   - second invocation of the same job is skipped (idempotent)

import { beforeAll, expect, it } from "vitest";
import { InMemoryAuditLogPort, silentLogger, StaticChangelogFetcher, StaticCodeSearchPort, StaticGithubAppPort, StaticIdentityPort, StaticLlmPort, StaticNotificationsPort, StaticNpmRegistryPort, StaticSecretsPort, InMemoryChangelogCachePort, FakeClock, InMemoryUpgradeQueue } from "../fakes.js";
import type { Ports } from "../../src/core/ports.js";
import { asInstallationId, asTeamId, asUpgradeId, type PrRef, type UpgradeJob } from "../../src/types.js";
import type { Config } from "../../src/config.js";
import { runUpgrader } from "../../src/workers/upgrader.js";
import { adaptersAgainstLocal, buildDocClient, integrationDescribe } from "./shared.js";

const config: Config = {
  env: "dev",
  logLevel: "error",
  region: "us-west-2",
  workos: {
    issuer: "https://api.workos.com",
    clientId: "client_test",
    teamClaim: "kiln_team_id",
  },
  tables: {
    teamConfig: "kiln-team-config",
    prLedger: "kiln-pr-ledger",
    auditLog: "kiln-audit-log",
    changelogCache: "kiln-changelog-cache",
    rateLimiter: "kiln-rate-limiter",
    githubTokenCache: "kiln-github-token-cache",
  },
  upgradeQueueUrl: "https://sqs.us-west-2.amazonaws.com/1/q.fifo",
  github: {
    appId: 1,
    secretArn: "arn:secret",
    rateCapacity: 4500,
    rateRefillPerSec: 1.25,
  },
  bedrock: {
    region: "us-west-2",
    classifierModel: "anthropic.claude-haiku-4-5",
    synthesizerModel: "anthropic.claude-sonnet-4-6",
    synthesizerEscalationModel: "anthropic.claude-opus-4-6",
  },
  timeouts: { npmMs: 5000, changelogMs: 10000, githubMs: 15000, bedrockMs: 30000, secretsMs: 5000 },
  poller: { intervalMinutes: 15 },
  telemetry: {
    enabled: false,
    serviceName: "kiln-test",
    resourceAttributes: "",
    metricExportIntervalMs: 60_000,
  },
  notifications: {},
};

const job: UpgradeJob = {
  teamId: asTeamId("team-pipeline"),
  upgradeId: asUpgradeId("u-pipe-1"),
  repo: { owner: "acme", name: "app", installationId: asInstallationId(1) },
  pkg: "react",
  fromVersion: "18.0.0",
  toVersion: "19.0.0",
  enqueuedAt: "2026-04-20T00:00:00Z",
  groupKey: "team-pipeline:acme/app:react",
};

integrationDescribe("upgrader pipeline", () => {
  let ports: Ports;
  let audit: InMemoryAuditLogPort;

  beforeAll(() => {
    audit = new InMemoryAuditLogPort();
    const adapters = adaptersAgainstLocal(buildDocClient());
    const opened: PrRef = {
      owner: "acme",
      repo: "app",
      number: 99,
      url: "https://github.com/acme/app/pull/99",
      headSha: "sha99",
    };
    ports = {
      npm: new StaticNpmRegistryPort(
        { react: { version: "19.0.0", publishedAt: "2026-04-19T00:00:00Z" } },
        { react: { repository: "https://github.com/facebook/react" } },
      ),
      changelog: new StaticChangelogFetcher({
        "https://raw.githubusercontent.com/facebook/react/HEAD/CHANGELOG.md":
          "## 19.0.0\n- Removed legacyContext.\n\n## 18.0.0\n- stuff",
      }),
      changelogCache: new InMemoryChangelogCachePort(),
      teamConfig: adapters.teamConfig,
      prLedger: adapters.prLedger,
      audit,
      rate: adapters.rateLimiter,
      llm: new StaticLlmPort(
        {
          breakingChanges: [
            {
              id: "remove-legacy",
              title: "Remove legacyContext",
              severity: "breaking",
              description: "legacyContext was removed",
              affectedSymbols: ["legacyContext"],
              changelogUrl: "https://github.com/facebook/react/releases/tag/v19.0.0",
            },
          ],
          summary: "Major rewrite, removes legacyContext.",
          confidence: 0.9,
        },
        {
          patches: [{ path: "src/app.tsx", before: "legacyContext", after: "createContext", citations: [] }],
          notes: "",
          warnings: [],
        },
      ),
      codeSearch: new StaticCodeSearchPort([
        { repo: "acme/app", path: "src/app.tsx", line: 3, symbol: "legacyContext", snippet: "legacyContext" },
      ]),
      github: new StaticGithubAppPort(opened),
      queue: new InMemoryUpgradeQueue(),
      identity: new StaticIdentityPort("team-pipeline"),
      secrets: new StaticSecretsPort(),
      notifications: new StaticNotificationsPort(),
      clock: new FakeClock(),
      logger: silentLogger(),
    };
  });

  it("first run opens a PR", async () => {
    const outcome = await runUpgrader(ports, config, job);
    expect(outcome.kind).toBe("pr-opened");
    expect(audit.written.at(-1)?.status).toBe("pr-opened");
    expect(audit.written.map((r) => r.status)).toContain("classifying");
    expect(audit.written.map((r) => r.status)).toContain("synthesizing");
  });

  it("second run with same idempotency key skips", async () => {
    const outcome = await runUpgrader(ports, config, job);
    expect(outcome.kind).toBe("skipped");
    expect(outcome.message).toBe("duplicate");
  });
});
