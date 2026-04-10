# spastic-memory

Persistent memory service for the spastic agent team. Every agent can write decisions, learnings, and context to a shared store — and query it semantically across sessions.

No distributed system. No ops. SQLite + local embeddings. Deploy and forget.

---

## What it does

- **Write:** agents POST memories with role, content, tags
- **Search:** semantic search via local `all-MiniLM-L6-v2` embeddings (no OpenAI API needed)
- **List:** recent memories, filterable by role or tag
- **Auto-summarize:** compresses old memories when the store gets large (>200 entries)
- **Seed:** ingests existing `/workspace/.spastic/memory.md` on startup
- **Persist:** SQLite in WAL mode — survives restarts, no data loss

---

## Quick Start (local)

```bash
# Install
pip install -e ".[dev]"

# Run
spastic-memory
# or: python -m spastic_memory.main

# Test it
curl -s http://localhost:8765/api/v1/health | python -m json.tool

# Write a memory
curl -s -X POST http://localhost:8765/api/v1/memories \
  -H 'Content-Type: application/json' \
  -d '{"role":"eng-backend","content":"We chose SQLite WAL mode for zero-ops deployment.","tags":["decision","database"]}' \
  | python -m json.tool

# Search
curl -s -X POST http://localhost:8765/api/v1/memories/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"what database did we choose?","top_k":5}' \
  | python -m json.tool
```

---

## AWS Deploy

```bash
git clone https://github.com/nanohype/protohype.git
cd protohype/spastic-memory
sudo bash deploy/install.sh
```

See [deploy/aws-setup.md](deploy/aws-setup.md) for full guide.

---

## Using from agent sessions

Copy `client/memory_client.py` into any session or add it to the workspace:

```python
from client.memory_client import MemoryClient

client = MemoryClient()  # defaults to http://127.0.0.1:8765

# Write what you learned
client.write(
    role="eng-backend",
    content="Chose SQLite WAL mode — solopreneur constraint, zero ops overhead.",
    tags=["decision", "database", "architecture"]
)

# Load context at session start
context = client.load_context("what infrastructure decisions did the team make?")
print(context)  # formatted block ready to inject into prompts

# Quick CLI use
# python client/memory_client.py search "database decisions"
# python client/memory_client.py recent 10
# python client/memory_client.py health
```

---

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/memories` | Write a memory |
| GET | `/api/v1/memories` | List memories (paginated) |
| POST | `/api/v1/memories/search` | Semantic search |
| DELETE | `/api/v1/memories/:id` | Delete a memory |
| POST | `/api/v1/memories/summarize` | Trigger compression |
| GET | `/api/v1/health` | Health + stats |

---

## Configuration

All config via environment variables (prefix `SPASTIC_MEMORY_`):

| Variable | Default | Description |
|----------|---------|-------------|
| `SPASTIC_MEMORY_DB_PATH` | `/workspace/.spastic/memory.db` | SQLite file path |
| `SPASTIC_MEMORY_SEED_MD_PATH` | `/workspace/.spastic/memory.md` | Seed file on startup |
| `SPASTIC_MEMORY_HOST` | `0.0.0.0` | Bind host |
| `SPASTIC_MEMORY_PORT` | `8765` | Port |
| `SPASTIC_MEMORY_EMBEDDING_MODEL` | `all-MiniLM-L6-v2` | Sentence-transformers model |
| `SPASTIC_MEMORY_SUMMARIZE_THRESHOLD` | `200` | Memory count to trigger auto-summarize |
| `SPASTIC_MEMORY_SUMMARIZE_BATCH_SIZE` | `50` | Memories to compress per run |
| `SPASTIC_MEMORY_SUMMARIZE_MIN_AGE_HOURS` | `24` | Min age of memories to summarize |

---

## Architecture

```
FastAPI (uvicorn)
    │
    ├── POST /memories        → db.insert_memory() + emb.embed()
    ├── GET /memories         → db.list_memories()
    ├── POST /memories/search → emb.embed(query) → top_k_similar() → db.get_memories_by_ids()
    └── POST /memories/summarize → summarizer.run_summarize()

Storage:
    SQLite (WAL mode)
    ├── memories table   (id, role, content, tags, is_summary, timestamps)
    └── embeddings table (id, memory_id, vector BLOB, model)

Embeddings:
    sentence-transformers all-MiniLM-L6-v2
    - 384 dimensions, ~80MB model, runs on CPU
    - Vectors stored as BLOB (float32 packed binary)
    - Similarity: cosine (dot product of normalized vectors via numpy)
```

---

## Running Tests

```bash
pip install -e ".[dev]"
pytest tests/ -v --cov=spastic_memory --cov-report=term-missing
```

---

## Security

- Binds to `127.0.0.1` by default (change only for trusted private subnets)
- No authentication in v1 (internal service, private network only)
- SQLite file permissions: `chmod 700 /workspace/.spastic/`
- See [security audit](../../artifacts/qa-security/security-audit-spastic-memory.md) for full findings
