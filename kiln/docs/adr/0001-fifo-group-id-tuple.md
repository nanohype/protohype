# ADR 0001 — FIFO group-id scoped to (team, repo, pkg)

## Status
Accepted (2026-04-20).

## Context
SQS FIFO queues serialize messages within a `MessageGroupId` and parallelize across groups. kiln's upgrader Lambda is fed from a FIFO queue. The question was how to pick group-id.

- `messageGroupId = teamId` — strong isolation, but a single team with 200 pending upgrades serializes all 200. Noisy-neighbor problem within the queue.
- `messageGroupId = teamId:repo:pkg` — still prevents racing on the same (team, repo, pkg) tuple (e.g., two workers computing patches for react 19.0.0 in the same repo). But unrelated pkg upgrades for the same team can run concurrently.
- `messageGroupId = random` — zero ordering guarantees; two workers could both try to open the same PR.

## Decision
`messageGroupId = ${teamId}:${repo}:${pkg}`.

## Consequences

- A team with 200 pending upgrades across 200 packages fans out to 200 concurrent workers.
- Per-team cost control moves from "FIFO group-id = teamId" to the DDB-backed rate bucket in `adapters/dynamodb/rate-limiter.ts`, keyed on `github:${teamId}`. The bucket is the cost ceiling; the FIFO group-id is the correctness guarantee.
- Idempotency against duplicate PR opens is handled by the PR ledger check before `createPullRequest`, not by FIFO ordering.

## Alternatives considered
- **No FIFO, use Standard SQS + dedup table.** More code, same guarantees. Rejected because FIFO gives us `MessageDeduplicationId` for free.
- **Partition the queue by team.** Would require N queues and N event sources. Doesn't scale past tens of teams.
