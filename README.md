# protohype

Prototyped ideas built from [nanohype](https://github.com/nanohype/nanohype) templates. Each project composes nanohype's AI systems, applications, and composable modules into a working application.

## Projects

| Project                     | What It Does                                                                                                                                                                                                                                                                                                           | Templates Used                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [sigint](sigint/)           | Competitive intelligence radar — crawls AI SaaS competitors, semantic diffs, LLM analysis, Slack alerts                                                                                                                                                                                                                | worker-service, data-pipeline, rag-pipeline, module-vector-store, module-notifications, slack-bot |
| [mcp-gateway](mcp-gateway/) | Three subsystems behind one HTTP API Gateway + shared bearer token auth: MCP switchboard (HubSpot, Google Drive, Calendar, Analytics, CSE, Stripe), DynamoDB-backed semantic memory server (sentence-transformers embeddings, cosine similarity), and a Next.js cost dashboard fed by an S3 cost-event ingest endpoint | infra-aws, mcp-server-ts, module-auth, module-vector-store                                        |
| [almanac](almanac/)         | Internal Slack knowledge bot over Notion, Confluence, Google Drive — per-user ACL enforced against each user's own OAuth tokens, hybrid k-NN+BM25 retrieval on pgvector (RDS Postgres), Bedrock Claude inference, KMS-encrypted token store, SQS+DLQ audit pipeline                                                    | slack-bot, rag-pipeline, module-vector-store, infra-aws                                           |
| [marshal](marshal/)         | Ceremonial incident commander — P1 war-room assembly ≤5 min, 100% IC-approval gate on customer Statuspage messages, Linear postmortem draft on resolve, Slack socket-mode                                                                                                                                              | ts-service, infra-aws, agentic-loop, prompt-library, module-llm                                   |
| [palisade](palisade/)       | Prompt-injection detection gateway and honeypot — reverse-proxies Bedrock / OpenAI / Anthropic, three-layer detection (heuristics → Bedrock classifier → pgvector corpus-match), two-phase label-approval gate for corpus growth, shape-aware honeypot endpoints, ci-eval regression gate                             | api-gateway, guardrails, module-llm-gateway, module-llm-providers, module-semantic-cache, module-vector-store, module-database-ts, module-rate-limit-ts, module-queue-ts, module-observability-ts, ci-eval, fine-tune-pipeline, infra-aws |

## What Is This

nanohype provides the building blocks — template skeletons for AI systems, applications, infrastructure, and composable modules. protohype shows what you can build by composing them.

Each project is a standalone, runnable application. Not a template — a real thing you can `npm install && npm run dev`.
