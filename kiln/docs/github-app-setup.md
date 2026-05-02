# GitHub App setup

One-time walkthrough. Creates a GitHub App, installs it on the customer's org, seeds the private key into Secrets Manager. ~15 minutes. Repeat per environment (staging + production get separate Apps so a staging key leak can't touch production repos).

## Prerequisites

- You are an admin of the customer's GitHub organization, or the customer is available to install your App during this walkthrough.
- The kiln AWS sub-account is provisioned and you can `aws secretsmanager put-secret-value` against it.
- You've already configured the WorkOS project ([`workos-setup.md`](./workos-setup.md) covers that if not).

## 1. Create the App

1. Go to `https://github.com/organizations/<your-org>/settings/apps/new` (for a customer-owned App, swap in their org slug; for a Kiln-wide App, use your own).
2. **GitHub App name:** `Kiln (staging)` / `Kiln (production)` — separate per env.
3. **Homepage URL:** your deployment URL (or `https://github.com/nanohype/kiln` until you have one).
4. **Webhook:** *disable* for v1. kiln is a pull-only integration — it polls npm + calls GitHub, it doesn't receive webhooks.
5. **Repository permissions:** set the following; everything else stays `No access`.

| Permission | Level | Why |
|---|---|---|
| Contents | Read & write | Create branches + commit patches |
| Pull requests | Read & write | Open PRs with migration notes |
| Metadata | Read-only | Required for every App; grants repo listing |

6. **Organization permissions:** leave all at `No access`.
7. **User permissions:** leave all at `No access`.
8. **Where can this GitHub App be installed?** — `Only on this account` if it's for one customer; `Any account` if it's a multi-tenant Kiln-wide App.
9. Click **Create GitHub App**.

## 2. Record the App ID

On the App settings page, copy the **App ID** (numeric). You'll paste it into `.env` / CDK env as `KILN_GITHUB_APP_ID` in step 5.

## 3. Generate a private key

1. Scroll to **Private keys** → **Generate a private key**. A `.pem` file downloads.
2. **Keep this file.** You'll upload it to Secrets Manager in step 5 and then delete the local copy. kiln never loads it from disk in production — it's only ever read from Secrets Manager.

## 4. Install the App on the customer org

1. On the App settings page, **Install App** → choose the customer org.
2. Choose **Only select repositories** and pick the repos kiln should operate on, OR **All repositories** for blanket access.
3. Copy the **Installation ID** from the URL: `https://github.com/organizations/<org>/settings/installations/<INSTALLATION_ID>`. This is per-customer; you'll store one per `RepoConfig.installationId` in the team-config table.

## 5. Seed the private key into Secrets Manager

```bash
# Replace path-to-key and account id.
aws secretsmanager create-secret \
  --name kiln/github-app-private-key \
  --description "GitHub App private key PEM — rotate quarterly" \
  --secret-string "$(cat /path/to/kiln-app-private-key.pem)"

# Record the ARN in your env / CDK context.
aws secretsmanager describe-secret --secret-id kiln/github-app-private-key \
  --query ARN --output text
```

Set the ARN as `KILN_GITHUB_APP_SECRET_ARN` (the CDK stack reads this at deploy time and grants only the worker Lambda role access).

**Delete the local PEM.**

```bash
shred -u /path/to/kiln-app-private-key.pem   # or `rm -P` on macOS
```

## 6. Verify

```bash
# Smoke-test that the App can mint an installation token.
export KILN_GITHUB_APP_ID=...
export KILN_GITHUB_APP_SECRET_ARN=arn:aws:secretsmanager:...

node -e "$(cat <<'EOF'
import { createAppAuth } from '@octokit/auth-app';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const sm = new SecretsManagerClient({});
const secret = await sm.send(new GetSecretValueCommand({ SecretId: process.env.KILN_GITHUB_APP_SECRET_ARN }));
const auth = createAppAuth({ appId: Number(process.env.KILN_GITHUB_APP_ID), privateKey: secret.SecretString });
const token = await auth({ type: 'installation', installationId: /* paste installation id */ });
console.log('minted token valid until', token.expiresAt);
EOF
)"
```

Expected: `minted token valid until 2026-04-20T01:00:00.000Z` (or similar; 1 hour from now).

If you see `unsupported key type` — the PEM has wrong line endings or was stored as base64. Re-download from GitHub, paste raw.

If you see `Could not find private key or PRIVATE KEY header` — the secret is truncated. Check `aws secretsmanager get-secret-value` shows the full PEM including `-----END RSA PRIVATE KEY-----`.

## Rotation

Quarterly cadence.

1. **Generate new key** in the App settings UI (you can have two active simultaneously during rollover).
2. `aws secretsmanager put-secret-value --secret-id kiln/github-app-private-key --secret-string "$(cat new.pem)"`.
3. In-flight Lambda invocations keep the old key until their 5-minute cache TTL expires. New invocations pick up the new key automatically.
4. Wait 10 minutes (two full TTL windows).
5. **Revoke the old key** in the App settings UI.

No Lambda redeploy needed — kiln fetches from Secrets Manager on cache miss.

## Separate apps per environment

Staging and production each get their own App, their own installation IDs, their own PEM. A staging PEM leak cannot touch production repos. CI uses the staging App; on-call rotates both independently.

| Env | App name | Secret name |
|---|---|---|
| staging | `Kiln (staging)` | `kiln/staging/github-app-private-key` |
| production | `Kiln (production)` | `kiln/production/github-app-private-key` |

The CDK stack per env reads its own secret ARN (see [`secrets.md`](./secrets.md)).

## Common verify failures

| Symptom | Cause | Fix |
|---|---|---|
| `Not Found` when installing the App | The App's install target setting is `Only on this account` but you clicked install from a different org | Change the install-target setting, or add the App to the other org |
| `HttpError: Bad credentials` from `@octokit/auth-app` | PEM pasted with CRLF line endings | Re-save as LF: `tr -d '\r' < in.pem > out.pem`, then `put-secret-value` again |
| `Error: Premium feature` on org install | GitHub App requires an org that's on a plan supporting it | Install on user account, or upgrade plan |
| kiln's worker logs `bad installation` | Per-repo `installationId` in team-config table doesn't match the App's actual installation | Re-check the URL on the install page, update `kiln-team-config` |
