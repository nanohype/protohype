# Agent Memory -- Product Requirements Document

## Problem

Multi-agent systems lack persistent, shared memory. Each agent session starts from scratch, losing decisions, context, and institutional knowledge accumulated during previous sessions. This leads to repeated discussions, contradictory decisions, and wasted compute.

## Solution

A lightweight memory service that agents can read from and write to. It stores structured memories with semantic search, so agents can query for relevant context before making decisions.

## Requirements

### Core

1. **Write memories** with a role (who wrote it), content (what was decided/observed), and tags (categorization)
2. **Search memories** semantically -- agents describe what they need in natural language, the service returns the most relevant stored memories
3. **List memories** with filtering by role, tag, and time range
4. **Delete memories** that are no longer relevant
5. **Auto-summarize** old memories to keep the working set small and focused

### Non-Functional

1. **Zero external dependencies at runtime** -- no vector database, no embedding API, no Redis. Just SQLite and a local model.
2. **Single-process deployment** -- one binary, one port, one database file.
3. **Fast startup** -- embedding model loads in seconds, not minutes.
4. **Low resource usage** -- runs comfortably on a t3.small (~$10/month).
5. **Idempotent seeding** -- can load initial context from a markdown file without duplicating on restart.

## Architecture Decisions

### SQLite with WAL Mode

Chosen for zero-ops deployment. No database server to manage, no connection pooling, no schema migrations toolchain. WAL mode provides concurrent reads during writes. The database is a single file that can be backed up with `cp` or `sqlite3 .backup`.

### Local Embeddings (sentence-transformers)

Embedding generation runs locally using `all-MiniLM-L6-v2`. This avoids API calls (cost, latency, privacy concerns) and works offline. The model is ~80 MB and produces 384-dimensional vectors. For this use case (matching decisions and context, not web-scale search), local embeddings are more than sufficient.

### Cosine Similarity in Application Code

Rather than using a vector database extension, similarity search runs in Python over all stored embeddings. This is viable because the expected corpus is small (hundreds to low thousands of memories, not millions). It avoids adding pgvector, Chroma, or similar dependencies.

### ULID for IDs

ULIDs are time-sortable, globally unique, and encode their creation timestamp. This means IDs double as rough chronological ordering without needing a separate sequence.

### Auto-Summarization

When memory count exceeds a configurable threshold, old memories are compressed into summary memories. The originals are deleted. This keeps the embedding search space small and reduces noise from outdated context.

## API Design

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/memories` | Write a new memory |
| GET | `/api/v1/memories` | List memories (paginated, filterable) |
| POST | `/api/v1/memories/search` | Semantic search |
| DELETE | `/api/v1/memories/{id}` | Delete a memory |
| POST | `/api/v1/memories/summarize` | Trigger manual summarization |
| GET | `/api/v1/health` | Health check with stats |

### Authentication

Optional API key via `X-API-Key` header. When `AGENT_MEMORY_API_KEY` is set, all endpoints except health require the key. When unset, everything is open. This supports both development (no auth) and production (locked down) without code changes.

## User Personas

### AI Agent

The primary consumer. Agents call the API at the start of a session to load relevant context, and write memories throughout the session to record decisions and observations.

### Human Operator

Uses the API (or the Python client) to inspect what agents have stored, seed initial context, and clean up irrelevant memories.

### System Administrator

Deploys the service, configures environment variables, sets up backups, and monitors health.

## Success Criteria

1. An agent can write a memory and retrieve it via semantic search within the same session
2. An agent starting a new session can find relevant context from previous sessions
3. The service runs reliably on minimal infrastructure without external dependencies
4. Auto-summarization keeps the working set under control without losing important context
5. The Python client works as a drop-in file with zero dependencies beyond stdlib
