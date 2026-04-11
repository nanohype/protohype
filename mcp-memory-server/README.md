# MCP Memory Server

A pluggable serverless memory system for MCP-compatible agents. Adds a `/memory` route to any existing API Gateway + Lambda CDK stack. Fully stateless Lambda, DynamoDB on-demand for persistence, optional semantic search via sentence-transformers.

## Architecture

```
MCP Client (any agent)
        │  HTTP POST (JSON-RPC 2.0)
        ▼
API Gateway  ─── /memory/{proxy+}
        │
        ▼
Lambda (Node 20) ── handler.ts
        │                │
        │          ┌─────┴──────┐
        │          │            │
        ▼          ▼            ▼
DynamoDB      Embedding      MCP Protocol
(persistence) Lambda         (JSON-RPC)
              (all-MiniLM)
```

**No EC2. No EFS. No SQLite. Pure serverless.**

## MCP Tools

| Tool | Description |
|---|---|
| `memory_store` | Persist a memory entry. Embedding computed automatically. |
| `memory_query` | Semantic search via cosine similarity. |
| `memory_list` | Paginated list, newest-first. Cursor-based pagination. |
| `memory_delete` | Delete a single memory by ID. Ownership-checked. |

## Quick Start

### 1. Deploy the embedding Lambda

```bash
cd embedding-lambda/
# Build and push container image (see layer/README.md for full steps)
docker build -t mcp-embedding-lambda .
# ... push to ECR ...
```

### 2. Deploy the CDK stack

```bash
cd infra/
npm install
EMBEDDING_FUNCTION_ARN=arn:aws:lambda:us-east-1:123456789:function:mcp-embedding \
  cdk deploy --require-approval never
```

### 3. Plug into an existing stack

```typescript
import { MemoryServerStack } from './lib/memory-server.stack';
import { EmbeddingFunction } from './lib/embedding-function.construct';

// In your existing CDK stack:
const embedding = new EmbeddingFunction(this, 'Embedding');

const memory = new MemoryServerStack(this, 'Memory', {
  existingApi: myExistingRestApi,
  embeddingFunctionArn: embedding.function.functionArn,
  ssmPrefix: '/mcp-memory/prod',
});
```

### 4. Connect from an MCP client

```python
# Using the MCP Python SDK
import httpx

endpoint = "https://abc123.execute-api.us-east-1.amazonaws.com/v1/memory"

# Store a memory
resp = httpx.post(endpoint, json={
    "jsonrpc": "2.0", "id": 1,
    "method": "tools/call",
    "params": {
        "name": "memory_store",
        "arguments": {
            "agentId": "my-agent",
            "content": "The user prefers dark mode.",
            "tags": ["preferences"]
        }
    }
})

# Query memories
resp = httpx.post(endpoint, json={
    "jsonrpc": "2.0", "id": 2,
    "method": "tools/call",
    "params": {
        "name": "memory_query",
        "arguments": {
            "agentId": "my-agent",
            "query": "What does the user prefer?",
            "topK": 3
        }
    }
})
```

## DynamoDB Schema

| Attribute | Type | Role |
|---|---|---|
| `agentId` | String | PK — partition by agent |
| `memoryId` | String | SK — ULID (time-sortable) |
| `content` | String | Raw text |
| `embedding` | String | JSON float32 array |
| `metadata` | String | JSON object |
| `tags` | StringSet | For filtering |
| `createdAt` | String | ISO-8601; GSI sort key |
| `expiresAt` | Number | Unix epoch (DynamoDB TTL) |

**GSI:** `agentId-createdAt-index` — enables `memory_list` (newest-first).

## Running Tests

Requires Java 8+ (for DynamoDB Local) and Node 20.

```bash
npm install
npm test          # all integration tests
npm test -- --coverage
```

## Scaling Notes

The `memory_query` operation loads all memories for an agent into Lambda memory to compute cosine similarity. This is efficient up to ~2,000 memories per agent (stays well under 512 MB at 384-dim floats). Above that:

1. Add a hard scan cap in `query.ts` (already recommended in security audit)
2. Migrate to Amazon OpenSearch Serverless for vector search at scale

## Security

See [`/workspace/artifacts/qa-security/security-audit.md`](../../workspace/artifacts/qa-security/security-audit.md).

**Required before production:** Add an API Gateway authorizer to validate `agentId` ownership.

## Cost

| Component | Pricing |
|---|---|
| DynamoDB | $1.25/M write RCUs, $0.25/M read RCUs (on-demand) |
| Lambda (memory handler) | ~$0.0000166667/GB-s at 512 MB |
| Lambda (embedding) | ~$0.0000166667/GB-s at 3 GB, ~100–500ms/call |
| API Gateway | $3.50/M requests |

Estimated cost at 10K memory operations/day: **< $1/day**.
