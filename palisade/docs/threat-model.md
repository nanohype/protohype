# palisade — threat model

Prompt-injection gateway. Assume the adversary is a well-resourced user with direct HTTP access to palisade's public endpoint.

## Assets

- **LLM upstream credentials.** Palisade forwards client-supplied `Authorization` / `x-api-key` headers unchanged; leaking them would be a stacking of compromises. Not palisade's direct concern but palisade must not log them.
- **Known-attack corpus.** The pgvector table. If an adversary can poison it (mark benign prompts as attacks, or delete attack rows), they can engineer detection bypass.
- **Audit log.** Compliance record. Must be append-only from the app's perspective. TTL deletion is expected; in-flight deletion is not.
- **Detection model behavior.** If an adversary can learn exactly which layer fired on which prompt, they can craft bypasses more efficiently.

## Threats (STRIDE-ish)

### Spoofing

- **T-S1: Spoofed `LABEL_APPROVED` audit event.** The gate trusts the audit log. If an attacker can write a bogus `LABEL_APPROVED`, they can get any prompt into the corpus.
  - Mitigation: gate is the single call site of `corpusWriter.addAttack()` (grep-enforced). Audit writes originate only from server-side code paths under IAM task role. The audit DDB table is not exposed to clients.
  - Residual: a compromised task role can forge events. Accept; palisade's trust boundary is the task role.

- **T-S2: Forged `Approve` admin call.** The `/admin/labels/:id/approve` endpoint has to be authed.
  - Mitigation: `ADMIN_API_KEY` is a Secrets-Manager-managed secret injected into the task; admin routes check it. (TODO — wire the middleware; currently the routes accept any caller. Gate until `ADMIN_AUTH` env is required.)

### Tampering

- **T-T1: Corpus write without approval.** Someone adds a new call site of `corpusWriter.addAttack()` outside the gate.
  - Mitigation: `scripts/ci/grep-gate.sh` fails CI. Reviewer signature required for any change to that script.

- **T-T2: Error-path leaks layer identity, model name, or upstream latency.** Gives adversaries a bypass signal.
  - Mitigation: `scripts/ci/grep-error-leak.sh` forbids layer/model identifiers in `c.json(...)` reject bodies. `rejectBody()` is the only allowed reject shape.

- **T-T3: `vi.mock(<sdk-package>)` in tests.** Lets a test bypass port-level fakes and coincidentally hide a real bug.
  - Mitigation: `scripts/ci/grep-vi-mock.sh`.

### Repudiation

- **T-R1: Attacker denies hitting the gate.** Every request gets a trace ID, every detection gets an audit event, every hit is fanned out to S3 via SQS.
  - Mitigation: `AUDIT_TTL_DAYS=366` means a year of audit history.

### Information disclosure

- **T-I1: Layer identity leaked via error shape.** See T-T2.
- **T-I2: Timing side-channel distinguishes honeypot from real.** Honeypot jitter window matches proxy p50.
- **T-I3: Bedrock model invocation logging enabled.** Account-level feature that could send prompts to CloudWatch.
  - Mitigation: CDK custom resource calls `DeleteModelInvocationLoggingConfiguration` on every `cdk deploy`.

### Denial of service

- **T-D1: Flooding the classifier to drive Bedrock costs.** Classifier is called only on UNCERTAIN; heuristics short-circuit obvious benign and malicious prompts. Rate limiter escalation throttles known-bad sources.
- **T-D2: Flooding benign traffic past rate limits.** Redis-backed sliding window + escalation. Fail-open on Redis error — accept DoS risk to avoid locking out real users.
- **T-D3: Slow-loris upstream.** AbortController with 30s timeout on the `fetch` forward.

### Elevation of privilege

- **T-E1: IAM policy wildcards on the task role.** Explicit resource ARNs per action; no `Resource: *` except CloudWatch PutMetricData (which has namespace condition).
- **T-E2: ECS Exec in production.** `enableExecuteCommand: false` in prod; staging only.

## Out of scope (by design)

- Client-side key management. Palisade does not issue, rotate, or scope upstream API keys.
- Output filtering / PII redaction on LLM responses. Use `guardrails` or `module-llm-observability` downstream.
- Adversarial classifier training. The classifier is consumed via Bedrock; retraining is optional and lives in the `fine-tune-pipeline` package.
