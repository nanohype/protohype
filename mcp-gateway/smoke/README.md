# Smoke tests

End-to-end tests against a deployed `McpGateway` stack. Exercises every
externally-visible behavior of the stack — authorizer gate, switchboard
routing, memory CRUD, dashboard aggregations, cost ingest, and the static
site served from CloudFront.

## Running

```bash
make smoke          # auto-discovers endpoint + token from CloudFormation
```

That target queries `McpGateway-ApiEndpoint` and `McpGateway-DashboardUrl`
from CloudFormation outputs and reads the gateway bearer token from Secrets
Manager, then invokes Jest with those values injected as env vars.

## Targeting a different stack

```bash
STACK_NAME=McpGatewayStaging make smoke
```

## What's covered

| File | Coverage |
|---|---|
| `health.smoke.ts` | `/health` is reachable, no auth required, returns expected shape |
| `auth.smoke.ts` | Authorizer rejects no-header / empty / wrong-token / wrong-scheme on both GET and POST routes |
| `switchboard.smoke.ts` | `tools/list` for all 6 services, MCP protocol error codes, routing validation |
| `memory.smoke.ts` | Full CRUD cycle (store → list → query → tag filter → delete), required-field validation, schema alignment (`text` not `content`) |
| `dashboard.smoke.ts` | All 6 GET aggregation endpoints, cost event ingest, validation edges, ingest+aggregate round-trip with `bySource` verification |
| `infrastructure.smoke.ts` | Dashboard root serves HTML, `config.json` reachable and points to the API endpoint |

Approximately 60 tests total.

## Not covered (intentionally)

- **Third-party API calls through the switchboard.** Would require populated
  service credentials and live third-party state. Out of scope for a stack
  smoke test. The switchboard tests cover tool discovery, routing, and MCP
  protocol compliance — enough to prove the gateway is wired correctly.
- **Authorizer timing attack resistance.** Requires statistical timing
  analysis; the unit test in `test/authorizer.test.ts` covers the
  `constantTimeEquals` function directly.
- **CloudFront edge caching behavior.** Hard to test deterministically and
  orthogonal to whether the stack works.

## Teardown

- Memories created during the run are deleted in `afterAll` hooks.
- Cost events can't be deleted via API — they use unique `smoketest-session-*`
  IDs so they're identifiable, and the bucket lifecycle expires them at 365d.

## Caveats

- **Cold start.** The first `memory_store` will trigger the embedding Lambda
  cold start (~30s to load the sentence-transformers container). Timeout is
  set to 60s; bump to 90s in `jest.smoke.config.js` if you hit timeouts.
- **Sequential execution.** Tests run with `maxWorkers: 1` to avoid
  authorizer cache thrashing and cost event ordering issues. A full suite
  run takes ~2–3 minutes on a warm stack, ~3–4 minutes on a cold one.
- **Eventual consistency.** The ingest→aggregate round-trip test sleeps 1.5s
  between the POST and the follow-up GETs. S3 PUT is strongly consistent for
  same-key reads, but the dashboard LISTs a prefix and then GETs — the
  delay covers any propagation lag.
