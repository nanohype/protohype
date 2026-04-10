# protohype

Prototyped ideas built from [nanohype](https://github.com/nanohype/nanohype) templates. Each project composes nanohype's AI systems, applications, and composable modules into a working application.

## Projects

| Project | What It Does | Templates Used |
|---------|-------------|----------------|
| [sigint](sigint/) | Competitive intelligence radar — crawls AI SaaS competitors, semantic diffs, LLM analysis, Slack alerts | worker-service, data-pipeline, rag-pipeline, module-vector-store, module-notifications, slack-bot |
| [mcp-proxy](mcp-proxy/) | Self-hosted MCP proxy — HubSpot, Google Drive, Calendar, Analytics, CSE, Stripe as remote MCP servers behind one AWS API Gateway + Lambda | mcp-server-ts, infra-aws, module-auth |

## What Is This

nanohype provides the building blocks — template skeletons for AI systems, applications, infrastructure, and composable modules. protohype shows what you can build by composing them.

Each project is a standalone, runnable application. Not a template — a real thing you can `npm install && npm run dev`.
