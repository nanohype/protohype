# protohype

Prototyped ideas built from [nanohype](https://github.com/nanohype/nanohype) templates. Each project composes nanohype's AI systems, applications, and composable modules into a working application.

## Projects

| Project | What It Does | Templates Used |
|---------|-------------|----------------|
| [sigint](sigint/) | Competitive intelligence radar — crawls AI SaaS competitors, semantic diffs, LLM analysis, Slack alerts | worker-service, data-pipeline, rag-pipeline, module-vector-store, module-notifications, slack-bot |
| [mcp-switchboard](mcp-switchboard/) | Self-hosted MCP gateway — HubSpot, Google Drive, Calendar, Analytics, CSE, Stripe as remote MCP servers behind one AWS API Gateway + Lambda | mcp-server-ts, infra-aws, module-auth |
| [mcp-gateway](mcp-gateway/) | Three subsystems behind one HTTP API Gateway + shared bearer token auth: MCP switchboard (HubSpot, Google Drive, Calendar, Analytics, CSE, Stripe), DynamoDB-backed semantic memory server (sentence-transformers embeddings, cosine similarity), and a Next.js cost dashboard fed by an S3 cost-event ingest endpoint | infra-aws, mcp-server-ts, module-auth, module-vector-store |
| [chorus](chorus/) | Cross-channel feedback intelligence — library scaffold for matching customer feedback (Zendesk / Delighted / Gong) to Productboard backlog via Bedrock Titan embeddings and pgvector cosine similarity. v0.1.0 ships utilities + matching primitives + schema; pipeline/API/UI to follow. | data-pipeline, rag-pipeline, module-vector-store, module-auth, infra-aws |

## What Is This

nanohype provides the building blocks — template skeletons for AI systems, applications, infrastructure, and composable modules. protohype shows what you can build by composing them.

Each project is a standalone, runnable application. Not a template — a real thing you can `npm install && npm run dev`.
