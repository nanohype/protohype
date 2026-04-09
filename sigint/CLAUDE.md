# sigint

Competitive intelligence radar — detect signals before they become headlines.

## What This Is

A protohype project in the nanohype ecosystem. It composes patterns from nanohype templates (worker-service, data-pipeline, rag-pipeline, module-vector-store, slack-bot) into a working application that monitors competitor websites for meaningful changes.

**Not a template** — this is a standalone application built from template patterns.

## How It Works

```
sources.json → Crawler → Pipeline (chunk → embed → semantic diff) → Alert Engine → Slack
                                                                          ↕
                                                               Intel Engine (query via Slack or CLI)
```

Core insight: semantic diffing via embedding cosine similarity, not text comparison. Only semantically novel content triggers alerts.

**Cold start:** On the first run, the vector store is empty, so every chunk scores as "new" (change score = 1.0). All sources will trigger alerts. Run `npm run crawl` (CLI, no Slack) first to establish a baseline, or set `SIGNIFICANCE_THRESHOLD=1.1` temporarily.

## Architecture

- **src/providers/** — Self-registering provider registry pattern (from nanohype). LLM (Bedrock/Anthropic/OpenAI), embeddings (Bedrock Titan/OpenAI), vector store (in-memory). All use `createRegistry<T>()`.
- **src/crawler/** — HTTP fetcher with per-host circuit breakers, HTML→text via cheerio with CSS selector scoping. Sequential crawling. Sources validated with Zod on load.
- **src/pipeline/** — Recursive text chunker with overlap → embed → semantic diff against stored vectors → `deleteByMetadata` old chunks → upsert new. A chunk is "new" if cosine similarity to best stored match < 0.85.
- **src/intel/** — Query facade: embed question → vector search → LLM-generated answer with context. Also LLM-powered change analysis (significance classification + signal extraction).
- **src/alerts/** — Threshold gating on change score → LLM analysis → Slack Block Kit formatting → dispatch. `formatDigest()` in `formatter.ts` is implemented but not yet wired up — intended for future daily/weekly digest scheduler jobs.
- **src/slack/** — @slack/bolt app. @mention and DM handlers for queries. `/sigint query|crawl|status` slash commands. Uses Socket Mode when `SLACK_APP_TOKEN` is set, HTTP mode otherwise.
- **src/scheduler/** — setInterval-based job runner. Runs a single global crawl covering all sources at a configurable interval. Crawl mutex prevents overlapping runs.
- **src/index.ts** — Wires everything together, starts scheduler + Slack bot, runs initial crawl, handles graceful shutdown.
- **src/cli.ts** — One-off `crawl` and `query` commands for use without Slack.

## Commands

```bash
npm run dev          # Start full system (scheduler + Slack bot)
npm run build        # Compile TypeScript to dist/
npm start            # Run compiled output
npm run crawl        # One-off crawl via CLI
npm run query -- "question"  # One-off query via CLI
npm test             # Run tests (vitest, 23 tests across 5 files)
npm run lint         # ESLint
```

## Configuration

All config via environment variables, validated by Zod in `src/config.ts`. See `.env.example` for the full list. Key ones:

- `LLM_PROVIDER` — bedrock (default), anthropic, or openai
- `EMBEDDING_PROVIDER` — bedrock (default) or openai
- `AWS_REGION` — for Bedrock (default us-east-1). Uses AWS credential chain — no API keys needed.
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` — only needed when using those providers directly
- `VECTOR_PROVIDER` — memory (default, **data lost on restart**)
- `SIGNIFICANCE_THRESHOLD` — 0–1, minimum change score to trigger alert (default 0.3)
- `CRAWL_INTERVAL_MINUTES` — default 60
- `LOG_LEVEL` — debug, info (default), warn, error. Zod-validated.
- `USER_AGENT` — HTTP User-Agent for crawl requests (default `sigint/0.1.0`)

Bedrock uses the AWS credential chain — `aws sts get-caller-identity` must work. No API keys needed. Requires model access to Claude Sonnet and Titan Embed v2 in Bedrock console.

Sources are defined in `sources.json` (see `sources.example.json` for 55 AI SaaS competitor sources across 30 companies). Validated with Zod on load.

## Conventions

- TypeScript, ESM (`"type": "module"`, `.js` extensions in imports)
- Node >= 22
- Zod for all validation (config, sources, log level)
- Structured JSON logging to stderr (`src/logger.ts`) — stdout reserved for CLI display
- Provider registry pattern: `createRegistry<T>(kind)` returns typed `{ register, get, has, names }`
- Circuit breaker for external calls — simple threshold-based, per-host for HTTP fetcher, per-provider for LLM and embeddings
- No framework lock-in for LLMs — direct SDK calls via provider interface
- Crawl mutex prevents overlapping runs from scheduler + slash command

## Testing

5 test files, 23 tests. Run with `npm test`.

- `src/providers/registry.test.ts` — registry factory (register, get, has, names, fresh instances)
- `src/pipeline/chunker.test.ts` — recursive text splitting (short text, long text, IDs, overlap)
- `src/pipeline/differ.test.ts` — semantic diff (empty store, high similarity, custom threshold)
- `src/resilience/circuit-breaker.test.ts` — trip, half-open probe, recovery
- `src/providers/vectors.test.ts` — memory store (upsert, search, filter, deleteByMetadata)

When adding tests: mock external providers by implementing the interface directly, don't mock SDK internals.

## Dependencies

- `@aws-sdk/client-bedrock-runtime` — Bedrock LLM (Converse API) + embeddings (Titan)
- `@anthropic-ai/sdk` / `openai` — direct API providers (optional)
- `@slack/bolt` — Slack bot
- `cheerio` — HTML parsing
- `zod` — config + schema validation
- `pg` — PostgreSQL (reserved for future pgvector provider)
