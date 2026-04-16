# Kiln AI Eval Results

## Eval Harness

Evals live in `src/ai/__tests__/evals/`. Run with:

```bash
npm run test:evals
```

Each eval uses golden test cases (mocked Bedrock responses) to validate:
1. Classification accuracy (breaking vs non-breaking)
2. Patch correctness (syntax, indentation, non-empty patchedLine)
3. Review case quality (concrete suggestedAction)
4. Cache-hit ratio reporting
5. Model selection (Sonnet vs Opus based on complexity)

## Pass Criteria

| Metric | Target | Source |
|--------|--------|--------|
| Classifier accuracy | ≥90% correct type assignment | `changelog-classifier.eval.test.ts` |
| Cache-hit ratio (warm) | ≥70% | `changelog-classifier.eval.test.ts` |
| Patches: non-empty patchedLine | 100% | `migration-synthesizer.eval.test.ts` |
| Review cases: concrete suggestedAction | 100% (length > 20 chars) | `migration-synthesizer.eval.test.ts` |
| Opus escalation at complexity ≥7 | Verified | `migration-synthesizer.eval.test.ts` |

## Golden Test Scenarios

### @aws-sdk/* v2 → v3
- S3Client constructor: region now required (mechanical patch)
- ServiceException subclass changes (breaking, no symbol)
- global.AWS deprecation (deprecation with symbol)

### React v17 → v18
- ReactDOM.render → createRoot (mechanical patch)
- Dynamic render target (human-review)
- Automatic batching (breaking, no symbol)

### Prisma v4 → v5
- $on() event name change: beforeExit removed (human-review with concrete suggestion)

## Latency Budget

| Stage | p50 (warm) | p99 (cold) |
|-------|-----------|-----------|
| Classify (Haiku) | 500ms | 2s |
| Analyze (Sonnet) | 2s | 8s |
| Synthesize (Sonnet) | 2s | 8s |
| Notes (Sonnet) | 1.5s | 6s |
| **Pipeline total** | **~6s** | **~24s** |

Latency budget measured against Bedrock Converse API with prompt caching warm.
The 30 s hard timeout per call covers p99 + network variance.

## Cost per 1000 Upgrades

Estimated at ~$0.13/upgrade pre-caching, ~$0.05/upgrade with sustained caching (75% cache hit ratio).

Actual costs will be tracked via `PipelineTokenUsage.cacheHitRatio` surfaced to Grafana.
