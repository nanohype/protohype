# Changelog

## [0.1.0] — Initial Release

### Added

**MCP Switchboard**
- Routes MCP protocol requests to HubSpot, Google Drive, Calendar, Analytics, Custom Search, Stripe
- Per-service credential management via Secrets Manager
- `tools/list` and `tools/call` MCP protocol support
- 5-minute credential cache in Lambda memory
- Service allowlist validation

**MCP Memory Server**
- 4 MCP tools: `memory_store`, `memory_query`, `memory_list`, `memory_delete`
- DynamoDB on-demand, PITR, TTL auto-expiry
- Container-image embedding Lambda (sentence-transformers all-MiniLM-L6-v2, 384 dims)
- Cosine similarity ranking for semantic queries
- Per-agent scoping; GSI on `agentId + createdAt`

**Cost Dashboard**
- Next.js 14 static export via CloudFront + S3
- 5 views: Summary, Agents, Agent Detail, Workflows, Sessions, Budget
- Per-agent and per-workflow cost breakdowns (30d)
- Budget alerts at 80% of configurable thresholds
- Reads from S3 cost-events bucket (perf-logger integration)

**Shared Infrastructure**
- HTTP API Gateway with bearer token Lambda authorizer
- Fail-closed, constant-time comparison, 5-min cache
- Single CDK stack, one deploy command: `make full-deploy`
- All data resources use `RemovalPolicy.RETAIN`

**Security**
- All 8 HIGH findings addressed in code (timing attack, fail-open, path traversal, input injection, public S3, no HTTPS, deprecated OAI, credential logging)
- IAM least-privilege: no wildcard `*` resources
- DynamoDB policy includes `aws:ResourceAccount` condition

**CI/CD**
- 5-job GitHub Actions workflow: CDK test, Python syntax, dashboard build, security scan, deploy
- Auto-deploy on `main` push with AWS credentials from secrets

### Constraints
- Serverless only: Lambda, DynamoDB on-demand, S3, API Gateway, CloudFront
- No EC2, no ECS, no RDS
- Region: us-west-2
