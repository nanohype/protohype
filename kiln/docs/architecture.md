# Kiln AI Pipeline — Architecture

## Overview

Kiln's AI layer is a 4-stage pipeline that transforms a raw vendor changelog + target codebase into a ready-to-apply migration plan.

```
Input (changelog + codebase files)
        │
        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Stage 0 – Guardrails (sync, no LLM)                                    │
│  • URL allowlist (SSRF prevention)                                       │
│  • Prompt injection detection                                            │
│  • Input size limits (200k chars changelog, 500k chars codebase)        │
└─────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────┐
│  Stage 1 – Changelog Classifier (Haiku)               │
│  Input:  raw changelog entries (split by heading/bullet) │
│  Output: typed ChangelogEntry[] with confidence       │
│  Cache:  system prompt cached (stable across calls)   │
│  Cost:   ~$0.01 per 1000 entries                      │
└───────────────────────────────────────────────────────┘
        │ breaking + security entries only
        ▼
┌───────────────────────────────────────────────────────┐
│  Stage 2 – Breaking Change Analyzer (Sonnet)          │
│  Input:  breaking entries + codebase files (batched)  │
│  Output: AffectedUsage[] with patchStrategy           │
│  Cache:  system prompt + entries list cached          │
│  Cost:   ~$0.50 per 100k codebase chars               │
└───────────────────────────────────────────────────────┘
        │
        ├── mechanical usages ──────────────────────────┐
        │                                               │
        ▼                                               ▼
┌─────────────────────────────────┐   ┌────────────────────────────────────┐
│  Stage 3a – Patch Synthesizer   │   │  Stage 3b – Review Case Advisor    │
│  (Sonnet; Opus if complexity≥7) │   │  (Sonnet)                          │
│  Output: FilePatch[]            │   │  Output: HumanReviewCase[]         │
└─────────────────────────────────┘   └────────────────────────────────────┘
        │                                               │
        └──────────────────────┬────────────────────────┘
                               ▼
┌───────────────────────────────────────────────────────┐
│  Stage 4 – Migration Notes Writer (Sonnet)            │
│  Input:  patches + review cases + changelog URLs      │
│  Output: PR-ready Markdown with ≥1 cited URL          │
│  Fallback: template-generated notes on LLM error      │
└───────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────┐
│  Output Guardrails (sync)                             │
│  • Patch file path safety (no absolute, no ..)        │
│  • Non-empty patchedLine                              │
│  • Migration notes cites ≥1 changelog URL             │
│  • "## Migration Notes" heading present               │
└───────────────────────────────────────────────────────┘
        │
        ▼
KilnMigrationPlan (patches + review cases + notes + token usage)
```

## LLM Policy

| Stage | Model | Reason |
|-------|-------|--------|
| Classify | `anthropic.claude-haiku-4-5` | Fast, cheap, classification task |
| Analyze | `anthropic.claude-sonnet-4-6` | Needs code understanding |
| Synthesize (simple) | `anthropic.claude-sonnet-4-6` | Complexity score < threshold |
| Synthesize (complex) | `anthropic.claude-opus-4-6` | Complexity score ≥ 7 (configurable via `KILN_COMPLEXITY_THRESHOLD`) |
| Notes | `anthropic.claude-sonnet-4-6` | Writing task |

Inference logging: **NONE** — set via CDK `PutModelInvocationLoggingConfiguration` at deploy time. Verified in CloudTrail.

Auth: IAM role. No API keys in code or env.

Region priority: `us-west-2` → `us-east-1` → `eu-central-1`.

## Prompt Caching

Every stage cache-points its stable system prompt. Stage 2 additionally cache-points the breaking-entries list, which is stable across multi-batch file analysis calls.

Expected cache-hit ratio: **0.75–0.85** on warm calls (system prompt served from cache).

## Cost per 1000 queries (estimated)

| Component | Tokens (est.) | Cost (est.) |
|-----------|---------------|-------------|
| Classifier (Haiku, 20 entries) | 4k in / 1k out | $0.002 |
| Analyzer (Sonnet, 100k chars) | 30k in / 3k out | $0.09 |
| Synthesizer (Sonnet, 10 patches) | 8k in / 2k out | $0.025 |
| Notes (Sonnet) | 3k in / 1.5k out | $0.011 |
| **Total per upgrade** | ~45k tokens | **~$0.13** |

Cache hits reduce input costs by ~75% on warm calls. Target: **<$0.05/upgrade** with sustained caching.

## Security

| Risk | Mitigation |
|------|-----------|
| SSRF via changelog URL | Domain allowlist enforced before any HTTP fetch |
| Prompt injection via changelog content | Pattern detection on first 5000 chars per file; changelog text |
| Context overflow | 200k changelog / 500k codebase char limits; file batching |
| Patch path traversal | Output guardrail rejects absolute paths and `..` |
| LLM timeout DoS | 30 s hard timeout per call via AbortController |
| Inference log data leak | Logging disabled at Bedrock model level (NONE) |

## Token Usage Reporting

`KilnMigrationPlan.tokenUsage` exposes per-stage and total token counts including `cacheReadInputTokens` and `cacheWriteInputTokens`. The `cacheHitRatio` field = `cacheReadInputTokens / (inputTokens + cacheReadInputTokens)` across the full pipeline run. Surface this in Grafana to track cost efficiency over time.
