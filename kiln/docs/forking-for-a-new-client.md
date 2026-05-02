# Forking kiln for a new client

kiln is a subsystem skeleton. A second deployment — for a different organization, under a different GitHub App, pointing at a different WorkOS project — is supported by design. This walkthrough covers every swap that's needed. Budget ~1 hour.

The port-based DI means application code changes are **none**. Everything is config + secrets + CDK stack scope.

## Before you start

- [ ] A dedicated AWS sub-account for the new client's kiln. Not shared with the original deployment or any other workload. See [ADR 0003](./adr/0003-dedicated-aws-subaccount.md).
- [ ] Admin access on the new client's GitHub organization (or the client available to install your App).
- [ ] The new client has a WorkOS project with a `kiln_team_id` custom claim configured. See [`workos-setup.md`](./workos-setup.md).
- [ ] Your local `kiln` checkout is on `main` (or the release tag you want to fork from).

## 1. Name the fork

Decide a short slug for the new client — e.g., `contoso`. This is a prefix, not a branch. Your two deployments will live at:

| Artifact | Original (acme) | Fork (contoso) |
|---|---|---|
| CloudFormation stack | `KilnStack` | `ContosoKilnStack` |
| DynamoDB tables | `kiln-team-config`, etc. | `contoso-kiln-team-config`, etc. |
| SQS queue | `kiln-upgrade-queue.fifo` | `contoso-kiln-upgrade-queue.fifo` |
| Lambda function names | `kiln-api`, `kiln-poller`, `kiln-upgrader` | `contoso-kiln-api`, etc. |
| Secrets Manager prefix | `kiln/production/*` | `contoso-kiln/production/*` |
| SNS alarm topic | `kiln-alarms` | `contoso-kiln-alarms` |
| Log groups | `/aws/lambda/kiln-*` | `/aws/lambda/contoso-kiln-*` |

To apply the prefix, set one env var at CDK synth time:

```bash
export KILN_RESOURCE_PREFIX=contoso
```

Wire this into the CDK app. Open `infra/lib/constructs/storage-construct.ts` and change:

```ts
tableName: "kiln-team-config"
```

to:

```ts
tableName: `${prefix}-kiln-team-config`
```

— or, equivalently, pass `prefix` through as a prop on each construct. Propagate to `secrets-construct.ts`, `poller-construct.ts`, `worker-construct.ts`, `observability-construct.ts`, `api-construct.ts`, and `lambda-factory.ts` (log group name + function name).

Alternatively, if you prefer a full rename over a prefix, do a find/replace: `rg "kiln" infra/ | ...`. The prefix approach is less invasive.

## 2. Third-party setup

Per-env breakdown. Most setup is identical to the original deployment walkthrough; the difference is each resource lives under the client's accounts.

| Resource | Owner | Setup doc |
|---|---|---|
| AWS sub-account | Your org (or the client's org if they pay their own AWS bill) | Whatever your org's provisioning process is |
| GitHub App | Per-client App (do NOT share across clients) | [`github-app-setup.md`](./github-app-setup.md) — repeat with `Contoso Kiln` as the App name |
| WorkOS project | Client's WorkOS org | Configure custom claim → `kiln_team_id`. See [`workos-setup.md`](./workos-setup.md) |
| Grafana Cloud stack (optional) | Client's Grafana Cloud | Create write-scoped access token; seed `grafana-cloud/otlp-auth`. See [`grafana-cloud-setup.md`](./grafana-cloud-setup.md) |
| Slack webhook | Client's workspace | Optional; alarms go here |
| Bedrock model access | Enable in the new sub-account for Haiku 4.5, Sonnet 4.6, Opus 4.6 in `us-west-2` + `us-east-1` | AWS Bedrock console |

## 3. Seed secrets

```bash
export CLIENT=contoso
export ENV=production
PEM_PATH=/path/to/contoso-kiln-app.pem

aws secretsmanager create-secret \
  --name "$CLIENT-kiln/$ENV/github-app-private-key" \
  --secret-string "$(cat "$PEM_PATH")"

# Optional:
aws secretsmanager create-secret \
  --name "$CLIENT-kiln/$ENV/slack/webhook-url" \
  --secret-string "https://hooks.slack.com/services/..."

shred -u "$PEM_PATH"
```

Every secret lives under a client-prefixed path. The forked Lambda role cannot read the original deployment's secrets (and vice versa) because they're in separate AWS accounts.

## 4. Deploy

```bash
export CDK_DEFAULT_ACCOUNT=<contoso sub-account id>
export CDK_DEFAULT_REGION=us-west-2
export KILN_ENV=production
export KILN_RESOURCE_PREFIX=contoso

export KILN_WORKOS_ISSUER=https://api.workos.com
export KILN_WORKOS_CLIENT_ID=client_CONTOSO_ID
export KILN_WORKOS_TEAM_CLAIM=kiln_team_id
export KILN_GITHUB_APP_ID=<contoso app id>
export KILN_GITHUB_APP_SECRET_ARN="arn:aws:secretsmanager:us-west-2:<account>:secret:contoso-kiln/production/github-app-private-key-XXXXXX"

npm ci
npm run cdk:synth
npm run cdk:diff
npm run cdk:deploy
```

## 5. Seed a smoke team + fire drill 1

Same as [`deployment-guide.md`](./deployment-guide.md) steps 4–6, but with the client-prefixed table name and the client's GitHub installation ID.

```bash
aws dynamodb put-item --table-name contoso-kiln-team-config --item file://smoke-team.json

aws lambda invoke --function-name contoso-kiln-poller /tmp/out.json && cat /tmp/out.json

aws logs tail /aws/lambda/contoso-kiln-upgrader --follow
```

## 6. Success criteria

- Health endpoint 200s with `{"status":"ok"}`.
- Poller enqueues ≥1 job on first invoke.
- Worker writes the audit trail `pending → classifying → scanning → synthesizing → pr-opened`.
- A real PR appears on the contoso test repo with migration notes citing the changelog.
- The Bedrock Config rule shows `COMPLIANT` (inference logging disabled).

If any fail, [`troubleshooting.md`](./troubleshooting.md) applies verbatim — the error messages are identical; only the stack/prefix names differ.

## What you should NOT touch

- `src/core/**` — pure domain logic. Changing it affects every deployment you have. Open a core PR against the canonical repo instead.
- `src/adapters/**` — infrastructure impls. Unless you're swapping *which* service implements a port (e.g., Linear instead of Slack), these are shared.
- `eslint.config.mjs` — the core-purity rule protects every deployment.
- Secrets outside your client's prefix.

## What you might want to change

- **Alarm thresholds.** The default `DLQ depth ≥ 1` may be noisy if the client has lots of non-migratable packages. Tune in `observability-construct.ts`.
- **Poller cadence.** `KILN_POLLER_INTERVAL_MINUTES=15` is the default. Large `watchedDeps` lists may want 30 or 60.
- **Bedrock models.** If the client has cost constraints, swap Sonnet → Haiku for synthesis at the expense of patch quality. Set `KILN_BEDROCK_SYNTHESIZER_MODEL=anthropic.claude-haiku-4-5`.
- **Changelog allowlist.** If the client has private npm changelogs hosted on their own GitHub Enterprise, extend `src/core/changelog/allowlist.ts` — and open a security review for that host. See [ADR 0005](./adr/0005-global-changelog-cache.md) for the cache scoping implications; private changelogs MUST use a separately-scoped cache table.

## Separate evolution

A forked deployment can lag the canonical release — redeploy from a specific tag:

```bash
git checkout v0.3.2
npm run cdk:deploy
```

Upgrading a fork:

```bash
git fetch origin
git checkout main
# Or: git checkout v0.4.0
npm run cdk:diff     # preview
npm run cdk:deploy   # apply
```

Because each deployment has its own AWS account and its own DynamoDB tables, upgrading one client does not affect another.
