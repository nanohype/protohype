# Agent Memory

Persistent memory service for multi-agent systems. Stores decisions, context, and knowledge with semantic search powered by local embeddings.

## What It Does

- **Write** structured memories with roles and tags
- **Search** semantically using cosine similarity over sentence embeddings
- **Auto-summarize** old memories to keep the working set small
- **Seed** initial context from a markdown file on startup
- **Zero external dependencies** at runtime -- SQLite for storage, local model for embeddings

## Quick Start

```bash
# Install
pip install -e ".[dev]"

# Run
agent-memory

# Or with uvicorn directly
uvicorn agent_memory.main:app --host 127.0.0.1 --port 8765
```

The service starts on `http://127.0.0.1:8765`. The embedding model downloads on first run (~80 MB).

## API

### Write a Memory

```bash
curl -X POST http://127.0.0.1:8765/api/v1/memories \
  -H "Content-Type: application/json" \
  -d '{"role": "eng-backend", "content": "Chose SQLite WAL mode for zero-ops deployment.", "tags": ["decision", "database"]}'
```

### Search Memories

```bash
curl -X POST http://127.0.0.1:8765/api/v1/memories/search \
  -H "Content-Type: application/json" \
  -d '{"query": "what database did we choose?", "top_k": 5}'
```

### List Memories

```bash
curl http://127.0.0.1:8765/api/v1/memories?limit=20&offset=0
```

### Health Check

```bash
curl http://127.0.0.1:8765/api/v1/health
```

### Delete a Memory

```bash
curl -X DELETE http://127.0.0.1:8765/api/v1/memories/{id}
```

### Trigger Summarization

```bash
curl -X POST http://127.0.0.1:8765/api/v1/memories/summarize
```

## Python Client

Drop `client/memory_client.py` into any agent project. Zero dependencies beyond stdlib.

```python
from memory_client import MemoryClient

client = MemoryClient()  # defaults to http://127.0.0.1:8765
client.write("eng-backend", "Chose SQLite WAL mode.", ["decision"])
results = client.search("database choice")
context = client.load_context("what database?")  # formatted for injection into prompts
```

CLI usage:

```bash
python client/memory_client.py health
python client/memory_client.py search "database decision"
python client/memory_client.py recent 10
python client/memory_client.py write eng-backend "Chose SQLite WAL mode." decision,database
```

## Configuration

All configuration is via environment variables with the `AGENT_MEMORY_` prefix.

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_MEMORY_HOST` | `127.0.0.1` | Bind address |
| `AGENT_MEMORY_PORT` | `8765` | Port |
| `AGENT_MEMORY_DB_PATH` | `./data/memory.db` | SQLite database path |
| `AGENT_MEMORY_API_KEY` | *(none)* | API key for authentication. When set, all endpoints except `/health` require `X-API-Key` header |
| `AGENT_MEMORY_EMBEDDING_MODEL` | `all-MiniLM-L6-v2` | Sentence-transformers model name |
| `AGENT_MEMORY_SEED_MD_PATH` | `./memory.md` | Path to seed markdown file |
| `AGENT_MEMORY_SEED_DEFAULT_ROLE` | `system` | Default role for unseeded sections |
| `AGENT_MEMORY_SUMMARIZE_THRESHOLD` | `100` | Memory count that triggers auto-summarization |
| `AGENT_MEMORY_SUMMARIZE_BATCH_SIZE` | `20` | Max memories per summarization batch |
| `AGENT_MEMORY_SUMMARIZE_MIN_AGE_HOURS` | `24` | Minimum age before a memory can be summarized |

## Authentication

When `AGENT_MEMORY_API_KEY` is set, all endpoints under `/api/v1/` (except `/health`) require the `X-API-Key` header:

```bash
curl -H "X-API-Key: your-key" http://127.0.0.1:8765/api/v1/memories
```

When `AGENT_MEMORY_API_KEY` is not set, all endpoints are open. The health endpoint is always public.

## Seeding from Markdown

Place a `memory.md` file at the configured `AGENT_MEMORY_SEED_MD_PATH`. On startup, the service parses `## Section` headers as roles and seeds each section as a memory. Re-seeding is skipped if the file hasn't changed (tracked by SHA-256 hash).

## Architecture

- **FastAPI** for the HTTP layer
- **SQLite** with WAL mode for storage (zero-ops, single-file database)
- **sentence-transformers** for local embedding generation (no API calls)
- **Cosine similarity** for semantic search over stored embeddings
- **ULID** for time-sortable unique IDs
- **Auto-summarization** compresses old memories to keep the working set focused

## Testing

```bash
pip install -e ".[dev]"
pytest tests/ -v
```

## Deployment

See `deploy/` for:
- `install.sh` -- idempotent installer for Ubuntu/Debian
- `agent-memory.service` -- systemd unit file
- `aws-setup.md` -- AWS deployment guide
