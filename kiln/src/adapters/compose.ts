// Composition root for production Ports. Each handler entrypoint calls this
// once at cold start. Tests construct their own Ports directly from fakes.

import type { Config } from "../config.js";
import type { Ports } from "../core/ports.js";
import { createLogger } from "../logger.js";
import { makeBedrockAdapter } from "./bedrock/client.js";
import { makeChangelogFetcher } from "./changelog-fetcher/client.js";
import { systemClock } from "./clock/index.js";
import { getDocClient } from "./dynamodb/client.js";
import { makeAuditLogAdapter } from "./dynamodb/audit-log.js";
import { makeChangelogCacheAdapter } from "./dynamodb/changelog-cache.js";
import { makeGithubTokenCache } from "./dynamodb/github-token-cache.js";
import { makePrLedgerAdapter } from "./dynamodb/pr-ledger.js";
import { makeRateLimiterAdapter } from "./dynamodb/rate-limiter.js";
import { makeTeamConfigAdapter } from "./dynamodb/team-config.js";
import { makeCodeSearchAdapter, makeGithubAppAdapter } from "./github-app/client.js";
import { makeNpmRegistryAdapter } from "./npm-registry/client.js";
import { makeSecretsAdapter } from "./secrets-manager/client.js";
import { makeWorkOSIdentityAdapter } from "./workos-authkit/verifier.js";
import { makeSlackNotificationsAdapter } from "./slack/notifications.js";
import { makeSqsUpgradeQueue } from "./sqs/queue.js";

export async function composePorts(config: Config): Promise<Ports> {
  const logger = createLogger({
    level: config.logLevel,
    service: "kiln",
    bindings: { env: config.env, region: config.region },
  });

  const doc = getDocClient(config.region);

  const secrets = makeSecretsAdapter({
    region: config.region,
    timeoutMs: config.timeouts.secretsMs,
    ttlMs: 5 * 60 * 1000, // 5 min; half the GitHub App JWT lifetime
  });

  // Lazy-load the GitHub App PEM. The Secrets Manager call is cached inside
  // the adapter so subsequent calls are free.
  const pemResult = await secrets.getString(config.github.secretArn);
  if (!pemResult.ok) throw new Error(`could not load GitHub App secret: ${pemResult.error.message}`);
  const privateKeyPem = pemResult.value;

  const tokenCache = makeGithubTokenCache(doc, config.tables.githubTokenCache);

  const github = makeGithubAppAdapter(
    {
      appId: config.github.appId,
      privateKeyPem,
      timeoutMs: config.timeouts.githubMs,
    },
    tokenCache,
  );

  const codeSearch = makeCodeSearchAdapter(github, config.timeouts.githubMs);

  const llm = makeBedrockAdapter({
    region: config.bedrock.region,
    classifierModel: config.bedrock.classifierModel,
    synthesizerModel: config.bedrock.synthesizerModel,
    synthesizerEscalationModel: config.bedrock.synthesizerEscalationModel,
    timeoutMs: config.timeouts.bedrockMs,
  });

  const ports: Ports = {
    npm: makeNpmRegistryAdapter({
      timeoutMs: config.timeouts.npmMs,
      userAgent: `kiln/${config.env}`,
      registryUrl: "https://registry.npmjs.org",
    }),
    changelog: makeChangelogFetcher({
      timeoutMs: config.timeouts.changelogMs,
      userAgent: `kiln/${config.env}`,
    }),
    changelogCache: makeChangelogCacheAdapter(doc, config.tables.changelogCache),
    teamConfig: makeTeamConfigAdapter(doc, config.tables.teamConfig),
    prLedger: makePrLedgerAdapter(doc, config.tables.prLedger),
    audit: makeAuditLogAdapter(doc, config.tables.auditLog),
    rate: makeRateLimiterAdapter(doc, config.tables.rateLimiter),
    llm,
    codeSearch,
    github,
    queue: makeSqsUpgradeQueue({ region: config.region, queueUrl: config.upgradeQueueUrl }),
    identity: makeWorkOSIdentityAdapter({
      issuer: config.workos.issuer,
      clientId: config.workos.clientId,
      ...(config.workos.jwksUrl ? { jwksUrl: config.workos.jwksUrl } : {}),
      teamClaim: config.workos.teamClaim,
    }),
    secrets,
    notifications: makeSlackNotificationsAdapter({
      webhookUrl: config.notifications.slackWebhookUrl,
      timeoutMs: 5_000,
    }),
    clock: systemClock,
    logger,
  };

  return ports;
}
