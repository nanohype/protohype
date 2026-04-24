# palisade — product requirements

## Problem

Teams deploying LLM endpoints (SaaS assistants, internal tools, agentic loops) need to block prompt-injection and jailbreak attempts before they hit the model. Existing options are either proprietary (Lakera, Prompt Armor, WhyLabs) with opaque heuristics, or library-level (guardrails-ai) which runs inside the app and can be bypassed by a compromised request path.

Palisade is a reverse-proxy: it sits between clients and LLM upstreams (Bedrock / OpenAI / Anthropic), runs layered detection on every prompt, blocks detections with a stable opaque error, and archives attempts for review and corpus growth.

## Users

- **Platform engineers** running multi-tenant LLM infrastructure.
- **AppSec teams** who need an auditable chokepoint in front of LLM calls.
- **Incident responders** investigating probes — honeypot fingerprints and attack-log archive give them the evidence.

## Goals

- Sub-200ms p50 added latency for benign prompts (heuristics fast-path).
- TPR ≥ 0.90 on the canonical attack set.
- FPR ≤ 0.02 on the canonical benign set.
- Human-in-the-loop corpus growth: every known-attack corpus entry is reviewer-approved.
- No attacker-observable signal in error responses.

## Non-goals

- Output-side content filtering (that's `guardrails` territory; palisade is input-side).
- Full LLM observability / cost tracking (`module-llm-observability` owns that).
- A single-tenant embedded library — palisade is explicitly a network gateway.

## Success metrics

- Detection rate on canonical eval set (TPR / FPR) — gated in CI.
- Gate verification failures (`palisade.gate.verification_failed`) — target: zero.
- Attack-log fan-out loss rate (`palisade.attack_log.fanout_failed`) — target: zero.
- P95 detection pipeline latency — target: < 500ms (heuristics + classifier cascade).

## Launch gates

- [ ] Gate tests at 100% branch coverage.
- [ ] Audit log tests at 100% branch coverage.
- [ ] CI grep-gates green.
- [ ] ci-eval baseline established and green on main.
- [ ] Honeypot endpoints serving synthetic-refusal responses indistinguishable by shape + timing.
- [ ] CDK stack synthesizes and deploys to staging; smoke.sh green.
- [ ] Runbook covers pgvector bootstrap, corpus rotation, and label-queue triage.
