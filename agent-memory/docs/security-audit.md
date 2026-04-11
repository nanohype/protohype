# Agent Memory -- Security Audit

## Scope

Review of the agent-memory service for security vulnerabilities, focusing on:
- Authentication and authorization
- Input validation
- Data storage security
- Network exposure
- Dependency risks

## Findings

### 1. Authentication

**Status**: Acceptable for intended use case.

- API key authentication is optional, controlled by `AGENT_MEMORY_API_KEY` environment variable
- When enabled, all endpoints except `/health` require the `X-API-Key` header
- The key is compared with constant-time string comparison (Python's `!=` on strings is not constant-time, but the risk is low for this use case)
- No rate limiting on authentication attempts

**Recommendations**:
- Always set `AGENT_MEMORY_API_KEY` in production
- Consider adding rate limiting if exposed to untrusted networks
- For high-security deployments, place behind a reverse proxy with TLS and additional auth

### 2. Input Validation

**Status**: Good.

- Content length is capped at 10,000 characters
- Role length is capped at 64 characters
- Tags are validated against `[a-zA-Z0-9_-]` regex with 64-char max per tag
- Maximum 10 tags per memory
- Search query length is capped at 1,000 characters
- `top_k` is bounded between 1 and 50
- Pagination limits are bounded (1-100 for limit, 0+ for offset)
- Pydantic handles type validation and coercion

**No SQL injection risk**: All database queries use parameterized statements via aiosqlite.

### 3. Data Storage

**Status**: Acceptable with caveats.

- SQLite database is stored as a plain file on disk -- not encrypted at rest
- Embeddings are stored as binary blobs (struct-packed floats)
- No PII-specific handling or data classification
- WAL mode means there are up to three files: `.db`, `.db-wal`, `.db-shm`
- The `meta` table stores the seed file hash, no sensitive data

**Recommendations**:
- Use filesystem-level encryption (LUKS, EBS encryption) for data at rest
- Ensure the data directory has restrictive permissions (700, owned by service user)
- The systemd service file includes `ProtectSystem=strict` and `ReadWritePaths` for defense in depth

### 4. Network Exposure

**Status**: Good defaults.

- Default bind address is `127.0.0.1` (localhost only)
- Must explicitly set `AGENT_MEMORY_HOST=0.0.0.0` to expose externally
- No TLS built in -- expected to run behind a reverse proxy for HTTPS
- Health endpoint is intentionally public (no auth required) for monitoring

**Recommendations**:
- Never expose directly to the internet without a reverse proxy
- Use security groups / firewall rules to restrict access to known agent IPs
- Enable TLS at the reverse proxy layer

### 5. Dependency Supply Chain

**Status**: Moderate risk (typical for Python projects).

| Dependency | Risk | Notes |
|------------|------|-------|
| FastAPI | Low | Well-maintained, widely audited |
| uvicorn | Low | Standard ASGI server |
| aiosqlite | Low | Thin wrapper over sqlite3 stdlib |
| python-ulid | Low | Simple ID generation |
| sentence-transformers | Medium | Large dependency tree (PyTorch, transformers, huggingface-hub) |
| numpy | Low | Widely used, well-maintained |
| pydantic | Low | Core validation library |
| pydantic-settings | Low | Settings management |

**Recommendations**:
- Pin dependency versions in production
- The sentence-transformers model is downloaded from Hugging Face Hub on first run -- ensure the model cache directory is trusted
- Consider vendoring or pre-downloading the model in air-gapped environments

### 6. Denial of Service

**Status**: Limited protection.

- No rate limiting on any endpoint
- Embedding generation is CPU-bound -- a burst of write requests could saturate the CPU
- Search queries compute cosine similarity against all stored embeddings -- O(n) per query
- No request size limits beyond Pydantic validation (10 KB max content is reasonable)

**Recommendations**:
- Add rate limiting at the reverse proxy layer (nginx, ALB)
- Monitor CPU usage and set up alerts
- The summarization feature naturally bounds the embedding count

### 7. Logging and Audit Trail

**Status**: Basic.

- Standard Python logging to stdout/stderr (captured by journald in systemd)
- No structured logging format
- No audit log of who wrote/deleted what (only the role field, which is self-reported)
- Summarization logs which memories were compressed

**Recommendations**:
- Add request logging middleware for audit trails if needed
- Consider structured JSON logging for production log aggregation

## Risk Summary

| Category | Risk Level | Action Required |
|----------|-----------|-----------------|
| Authentication | Low | Set API key in production |
| Input validation | Low | No action needed |
| Data storage | Medium | Enable disk encryption |
| Network exposure | Low | Keep default localhost binding |
| Dependencies | Medium | Pin versions, audit model source |
| Denial of service | Medium | Add rate limiting at proxy layer |
| Logging | Low | Acceptable for current scale |

## Overall Assessment

The service is appropriate for its intended use case: an internal tool for multi-agent coordination, deployed on a private network. The main risks are standard for any web service (lack of rate limiting, unencrypted storage) and are mitigated by the deployment architecture (localhost binding, systemd hardening, private subnet).

For production deployments handling sensitive data, add: TLS termination, disk encryption, rate limiting, and structured audit logging.
