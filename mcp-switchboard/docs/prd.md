# PRD: MCP Switchboard — Self-Hosted Multi-Service Remote MCP Gateway

**Status:** Approved  
**Owner:** Product  
**Audience:** Solopreneur running 51-agent managed agent team  
**Deploy target:** AWS (API Gateway + Lambda)

---

## Problem

Six services the agent team needs daily — HubSpot, Google Drive, Google Calendar, Google Analytics, Google Custom Search, and Stripe — have no hosted MCP servers. Each agent that needs them either (a) can't access them or (b) requires custom tool implementations per-agent. This creates duplication, drift, and maintenance overhead.

## Solution

A single self-hosted MCP proxy deployed to AWS that exposes all six services as remote MCP servers behind one API Gateway endpoint. Each service lives at its own path. Agents connect with a single base URL + the service path. Auth is centralized in AWS Secrets Manager.

---

## Routes

| Path | Service | Auth Secret |
|------|---------|-------------|
| `/hubspot` | HubSpot CRM | `mcp-switchboard/hubspot` |
| `/gdrive` | Google Drive | `mcp-switchboard/gdrive` |
| `/gcal` | Google Calendar | `mcp-switchboard/gcal` |
| `/analytics` | Google Analytics 4 | `mcp-switchboard/analytics` |
| `/gcse` | Google Custom Search | `mcp-switchboard/gcse` |
| `/stripe` | Stripe | `mcp-switchboard/stripe` |

---

## Tool Inventory

### HubSpot (`/hubspot`)
| Tool | Description |
|------|-------------|
| `hubspot_list_contacts` | List/search contacts with filters |
| `hubspot_get_contact` | Get contact by ID |
| `hubspot_create_contact` | Create new contact |
| `hubspot_update_contact` | Update contact properties |
| `hubspot_list_deals` | List/search deals |
| `hubspot_get_deal` | Get deal by ID |
| `hubspot_create_deal` | Create new deal |
| `hubspot_update_deal` | Update deal properties |
| `hubspot_list_companies` | List/search companies |
| `hubspot_create_note` | Create activity note on a contact/deal |

### Google Drive (`/gdrive`)
| Tool | Description |
|------|-------------|
| `gdrive_list_files` | List files in a folder |
| `gdrive_search_files` | Search files by query string |
| `gdrive_get_file` | Get file metadata |
| `gdrive_read_file` | Read text file content |
| `gdrive_create_file` | Create or upload a file |

### Google Calendar (`/gcal`)
| Tool | Description |
|------|-------------|
| `gcal_list_calendars` | List accessible calendars |
| `gcal_list_events` | List events in time range |
| `gcal_get_event` | Get event details |
| `gcal_create_event` | Create a new event |
| `gcal_update_event` | Update an existing event |
| `gcal_delete_event` | Delete an event |

### Google Analytics (`/analytics`)
| Tool | Description |
|------|-------------|
| `ga_run_report` | Run a GA4 report (metrics + dimensions) |
| `ga_realtime_report` | Get realtime active users |
| `ga_list_properties` | List GA4 properties |

### Google Custom Search (`/gcse`)
| Tool | Description |
|------|-------------|
| `gcse_search` | Web search via Custom Search API |
| `gcse_search_images` | Image search via Custom Search API |

### Stripe (`/stripe`)
| Tool | Description |
|------|-------------|
| `stripe_get_balance` | Get account balance |
| `stripe_list_customers` | List/search customers |
| `stripe_get_customer` | Get customer details |
| `stripe_list_payments` | List payment intents |
| `stripe_get_payment` | Get payment intent details |
| `stripe_list_subscriptions` | List subscriptions |
| `stripe_get_subscription` | Get subscription details |
| `stripe_list_invoices` | List invoices |
| `stripe_get_invoice` | Get invoice details |

---

## Auth Contract

**Secrets Manager schema per service:**

```json
// mcp-switchboard/hubspot
{ "apiKey": "pat-na1-..." }

// mcp-switchboard/gdrive  
{ "serviceAccountKey": "{...full SA JSON...}" }

// mcp-switchboard/gcal
{ "serviceAccountKey": "{...full SA JSON...}", "impersonateEmail": "user@domain.com" }

// mcp-switchboard/analytics
{ "serviceAccountKey": "{...full SA JSON...}", "propertyId": "123456789" }

// mcp-switchboard/gcse
{ "apiKey": "AIza...", "engineId": "abc123..." }

// mcp-switchboard/stripe
{ "secretKey": "sk_live_..." }
```

**Caller auth:** API Gateway resource policy or an `x-api-key` header validated at the Gateway level. No auth token is passed to the Lambda — the Gateway handles caller identity.

---

## Transport

**MCP Streamable HTTP** (2025 spec):
- `POST /{service}` — all JSON-RPC messages
- Stateless: no session persistence required (each Lambda invocation is fresh)
- `sessionIdGenerator: undefined` in `StreamableHTTPServerTransport`
- Response: JSON (no SSE required for agent tool calls)

---

## Non-Goals (v1)
- OAuth user-delegated auth (service accounts only for Google)
- SSE streaming responses (not needed for agent tool calls)
- Multi-tenant (single AWS account, single owner)
- Rate limiting per tool (managed externally)

---

## Success Criteria
1. All 6 services respond to MCP `initialize` + tool call from a Claude agent
2. Cold start < 3s on first invocation
3. Secrets never logged or surfaced in responses
4. CDK deploys clean on `cdk deploy` with no manual steps
5. All 6 secret schemas documented for operator setup
