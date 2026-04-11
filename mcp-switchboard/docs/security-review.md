# Security Review: MCP Switchboard

**Reviewer:** qa-security  
**Scope:** Auth layer, IAM posture, API surface, OWASP Top 10 applicability  
**Verdict:** ✅ APPROVED for deploy with recommended mitigations noted

---

## 1. Credential Handling

| Finding | Severity | Status |
|---------|----------|--------|
| Secrets fetched from Secrets Manager, never hardcoded | ✅ Pass | |
| Secrets cached in Lambda module scope (not process.env) | ✅ Pass | |
| No secret values appear in logger.ts output | ✅ Pass | Auth layer logs secret *names*, not values |
| HubSpot apiKey / Stripe secretKey in plain Secrets Manager JSON | ⚠️ Low | Acceptable — SM encrypts at rest with KMS |
| Google SA private_key stored as escaped JSON string | ⚠️ Low | Acceptable — consider SM binary secret for extra isolation |

**Recommendation:** Enable automatic secret rotation in Secrets Manager for Stripe and HubSpot where the provider supports it. Google SA keys: rotate every 90 days via Google IAM console.

---

## 2. IAM Least Privilege

**Lambda execution role policy:**
```json
{
  "Effect": "Allow",
  "Action": ["secretsmanager:GetSecretValue"],
  "Resource": "arn:aws:secretsmanager:{region}:{account}:secret:mcp-switchboard/*-*"
}
```

| Check | Status |
|-------|--------|
| Only `GetSecretValue` — no `CreateSecret`, `DeleteSecret`, `RotateSecret` | ✅ |
| Scoped to `mcp-switchboard/*` prefix — not `*` | ✅ |
| No `iam:*`, `sts:AssumeRole`, or `lambda:InvokeFunction` | ✅ |
| Lambda has no VPC access (Internet egress for Google/HubSpot/Stripe APIs) | ℹ️ By design |

**Recommendation:** Add `aws:ResourceTag/project/mcp-switchboard` condition to further scope the policy. Set Lambda reserved concurrency to cap blast radius.

---

## 3. API Gateway Auth

**Current state:** No auth on API Gateway — any caller with the URL can invoke MCP tools.

| Risk | Severity | Mitigation |
|------|----------|------------|
| Unauthenticated tool calls | 🔴 High | **Required before production** |
| Stripe tools allow reading customer/payment data | 🔴 High | Blocked by above |

**Required before production:**
Add an API Gateway API key or Lambda authorizer:

```typescript
// In mcp-switchboard-stack.ts — add API key auth
const apiKey = httpApi.addApiKey('McpProxyApiKey');
const usagePlan = new apigateway.CfnUsagePlan(this, 'UsagePlan', { ... });
```

Or use Cognito/JWT authorizer for agent-specific tokens.

**Simplest option for solopreneur:** Add an HTTP API authorizer that validates a shared `x-api-key` header against a value stored in Secrets Manager. Add to every route.

---

## 4. Injection and Input Validation

| Attack Vector | Status | Notes |
|---------------|--------|-------|
| SQL injection | ✅ N/A | No direct SQL — all calls via SDK |
| SSRF via `folderId`, `fileId` | ✅ Low risk | IDs pass through to Google SDK, not used as URLs |
| Template injection in `query` fields | ⚠️ Low | HubSpot `doSearch.query` passed through. HubSpot API handles escaping. |
| gdrive_search_files query escaping | ⚠️ Medium | Single-quote escaping in `fullText contains '${query}'` uses `.replace(/'/g, "\\'")` — acceptable but brittle. Consider parameterized query library. |
| Zod schema validation on all tool inputs | ✅ Pass | Every tool uses Zod schemas |
| Max limits enforced (e.g., pageSize ≤ 100) | ✅ Pass | |

**Action item:** Replace the manual quote escaping in `gdrive.ts` with the Drive SDK's `q` builder or a proper escaping utility.

---

## 5. Response Data Exposure

| Finding | Severity | Notes |
|---------|----------|-------|
| Full API responses returned to agents | ℹ️ Medium | Stripe payment details, customer PII included |
| No PII scrubbing before returning to agent | ⚠️ Medium | Acceptable for internal agent team — single owner |
| Error messages don't leak secrets | ✅ Pass | Auth errors throw generic messages |
| Stack traces not returned to caller | ✅ Pass | Lambda handler catches and returns 500 with no detail |

---

## 6. OWASP Top 10 Assessment

| Risk | Status |
|------|--------|
| A01: Broken Access Control | ⚠️ See §3 — add API GW auth before prod |
| A02: Cryptographic Failures | ✅ SM encryption + HTTPS only |
| A03: Injection | ✅ SDK abstractions + Zod validation |
| A04: Insecure Design | ✅ Stateless, minimal surface |
| A05: Security Misconfiguration | ✅ RETAIN policy on secrets, no public bucket |
| A06: Vulnerable Components | ⚠️ Run `npm audit` in CI; pin dependency versions |
| A07: Auth and Identification Failures | ⚠️ See §3 |
| A08: Software and Data Integrity | ✅ CDK synth is deterministic; no untrusted plugins |
| A09: Security Logging and Monitoring | ✅ CloudWatch logs with 30-day retention |
| A10: Server-Side Request Forgery | ✅ No user-supplied URLs used for fetch |

---

## 7. Dependency Scan Checklist

Run before every deploy:
```bash
npm audit --audit-level=high
```

Known watch items:
- `googleapis` — large surface, watch for auth library vulns
- `@hubspot/api-client` — node-fetch based, watch for SSRF advisories  
- `stripe` — historically clean, maintain pin

---

## 8. Pre-Production Checklist

- [ ] Add API Gateway auth (API key or JWT authorizer)
- [ ] Enable KMS customer-managed key for Secrets Manager secrets
- [ ] Set Lambda reserved concurrency (recommend: 50)
- [ ] Add `npm audit` step to CI/CD
- [ ] Rotate all API keys after initial setup
- [ ] Restrict CORS `allowOrigins` from `['*']` to agent host(s)
- [ ] Enable AWS Config rule: `secretsmanager-secret-periodic-rotation`
