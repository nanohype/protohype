# WorkOS AuthKit setup

One-time walkthrough. Configures WorkOS AuthKit / User Management to issue JWTs that kiln's API Gateway verifies. ~10 minutes. Repeat per environment (staging + production get separate WorkOS projects so a staging misconfiguration can't authenticate against production).

## Prerequisites

- You are an admin of your WorkOS organization (or the customer's, if per-tenant).
- The kiln AWS sub-account is provisioned and you can `aws secretsmanager put-secret-value` against it.

## 1. Create a WorkOS project

1. Go to `https://dashboard.workos.com/environments` and create a new environment named `kiln-staging` / `kiln-production` (or use existing per-client environments).
2. In **Authentication**, enable **AuthKit** (hosted login) OR configure your chosen federation (SSO SAML/OIDC) — either issues standard OIDC JWTs that kiln can verify.
3. Note:
   - **Client ID** (`client_XXXXXX`) — shown on the API Keys page.
   - **Issuer URL** — typically `https://api.workos.com` for the hosted AuthKit, or your AuthKit project URL.
   - **JWKS URL** — auto-derived by kiln as `${issuer}/sso/jwks/${clientId}`. Override via `KILN_WORKOS_JWKS_URL` if your deployment uses a different path.

## 2. Add the `kiln_team_id` custom claim

kiln resolves the caller's team from a dedicated claim, never from `sub` or email. Configure WorkOS to emit it on every session token:

1. WorkOS dashboard → **Authentication** → **Sessions** → **Custom Claims**.
2. Add a claim named `kiln_team_id` of type `string`.
3. Source: map from the authenticated user's organization id, directory-sync group, or whatever your identity model treats as "team." For WorkOS AuthKit hosted login with per-org sign-in, mapping from `organization.external_id` is typical.
4. Save.

Alternative claim name: set `KILN_WORKOS_TEAM_CLAIM` to whatever you chose.

## 3. Record connection details

Stash these for the kiln CDK deploy:

```bash
export KILN_WORKOS_ISSUER="https://api.workos.com"
export KILN_WORKOS_CLIENT_ID="client_YOUR_ID_HERE"
export KILN_WORKOS_TEAM_CLAIM="kiln_team_id"
```

(You can paste these into `.env` for local dev or the CDK env for deploy.)

## 4. Optional — API key for server-side calls

If kiln needs to call the WorkOS Management API server-side (not used in v1; reserved), generate an API key and seed it:

```bash
aws secretsmanager create-secret \
  --name "kiln/staging/workos/api-key" \
  --secret-string "sk_live_YOUR_KEY"
```

The seeder (`scripts/seed-secrets.sh`) reads `workos/api-key` from `kiln-secrets.*.json`; leave it `null` if you don't need it.

## 5. Verify

```bash
# Mint a test token from WorkOS (hosted AuthKit) or your SSO IdP, then:
export TOKEN="eyJhbGc..."

# Verify the JWT shape locally without calling kiln:
echo "$TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | jq .
# Expected: iss == KILN_WORKOS_ISSUER, aud == KILN_WORKOS_CLIENT_ID, kiln_team_id claim present

# Once kiln is deployed, hit the API:
curl -H "Authorization: Bearer $TOKEN" https://<api-url>/teams/your-team-id
# Expected: 200 with team config; 403 if kiln_team_id claim doesn't match URL :teamId; 401 if token invalid.
```

## Separate environments

Staging and production each get their own WorkOS project (or at minimum, separate environments within the same project). Different issuer/clientId per env means a compromised staging credential cannot authenticate against production.

| Env | Client ID env var | Issuer env var |
|---|---|---|
| staging | `KILN_WORKOS_CLIENT_ID=client_STG...` | `KILN_WORKOS_ISSUER=https://api.workos.com` |
| production | `KILN_WORKOS_CLIENT_ID=client_PRD...` | `KILN_WORKOS_ISSUER=https://api.workos.com` |

## Rotation

WorkOS signing keys rotate automatically. Because kiln uses remote JWKS (via `jose.createRemoteJWKSet`), rotation is transparent — no redeploy, no secret update.

If your WorkOS API key (for the optional Management API) is compromised, revoke + issue new in the dashboard, then `aws secretsmanager put-secret-value` with the new key. Warm Lambdas pick up the new value within 5 minutes (the secrets adapter TTL).

## Common verify failures

| Symptom | Cause | Fix |
|---|---|---|
| `401 unauthorized` with `missing or non-string claim "kiln_team_id"` | Custom claim not emitted or wrong name | Check WorkOS Custom Claims config; verify the token payload with `jq` |
| `401 unauthorized` with `"aud" claim check failed` | `KILN_WORKOS_CLIENT_ID` doesn't match the token's `aud` | Confirm clientId matches the WorkOS environment that issued the token |
| `401 unauthorized` with `"iss" claim check failed` | Different issuer than expected | Check WorkOS dashboard for the exact issuer URL of your environment |
| `403 forbidden — teamId mismatch` | `kiln_team_id` claim ≠ URL `:teamId` | By design — cross-tenant reads are blocked. The caller is addressing the wrong team |
| Lambda logs `AccessDeniedException` when fetching JWKS | Outbound HTTPS egress blocked to `api.workos.com` | Loosen the VPC egress rule or route via NAT gateway |
| `KILN_WORKOS_ISSUER` rejected as invalid URL | Zod schema requires `https://`; missing scheme or typo | Include scheme, no trailing whitespace |
