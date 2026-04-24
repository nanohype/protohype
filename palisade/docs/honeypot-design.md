# palisade — honeypot design

Honeypot routes are decoys that look like the real LLM endpoints but never forward to an upstream. They exist to:

1. Detect automated probes sweeping for unprotected LLM APIs.
2. Fingerprint probe tooling (UA + header-set + content-type + body-size distribution).
3. Feed the attack-log corpus with real-world adversarial prompts.
4. Escalate the attacker's rate-limit on the _real_ endpoints too — so a scan against the honeypot costs the adversary their quota on the live path.

## Shape

Routes:

- `POST /honeypot/v1/chat/completions` (OpenAI-shaped)
- `POST /honeypot/v1/messages` (Anthropic-shaped)
- `POST /honeypot/bedrock/invoke-model` (Bedrock-shaped)

Each route:

1. Normalizes the request body (same `normalize()` function as the real proxy).
2. Captures identity, fingerprint, and raw prompt.
3. Waits for a jittered latency matching the real proxy's p50 (+/- 90ms).
4. Returns a synthetic refusal shaped like the impersonated upstream. `"id"`, `"model"`, `"stop_reason"` fields are all populated with plausible values so a client that only parses the happy path can't distinguish real from decoy.
5. Writes a `HONEYPOT_HIT` audit event.
6. Fans out to SQS → S3 archive via the same pipe as real attack-log records.
7. Escalates the identity's rate-limit with severity `"hard"` (TTL = `RATE_LIMIT_ESCALATION_SECONDS`, default 15min).

## Fingerprint

`fingerprintHit(headers, bodyLength)` produces a 32-char stable hex fingerprint over:

- header names (sorted, lowercase, minus auth + content-length + palisade-scoped)
- user-agent first 64 chars
- content-type
- body-length bucket (S < 256, M < 2048, L < 16384, XL otherwise)

Rationale: IP alone is too variable (residential proxies, Tor); UA alone is too easy to spoof. The sorted header-name set is what survives most off-the-shelf scanning frameworks.

## Synthetic refusal bank

Five short refusals. Selected by `parseInt(promptHash.slice(0,2), 16) % 5` so a given prompt always gets the same refusal — an adversary rehashing the same input can't walk the bank.

## What the honeypot does NOT do

- Call a real LLM for the response. That would:
  1. Cost money per probe.
  2. Potentially return an adversary-useful answer.
  3. Put upstream credentials through a path intended to absorb hostile traffic.
- Log raw response bodies. The synthetic-refusal response body is known statically; logging it is noise.
- Emit layer-identifying or model-identifying content. Response `model` fields use generic public names (`gpt-4o`, `claude-sonnet-4-6`) that match the impersonated upstream's typical client expectation, not palisade's real upstream choice.

## Discovery strategy

Honeypot routes should be advertised the way attackers expect to find unprotected LLM APIs: directory enumeration, stolen-documentation discovery, and common-path brute force. Palisade does NOT advertise them in `/health` or `/openapi.json`. Placement on a subdomain (e.g. `api-v1.example.com` pointing at the same ALB) is the recommended deployment pattern.
