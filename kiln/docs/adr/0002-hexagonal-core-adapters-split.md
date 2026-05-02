# ADR 0002 — Hexagonal core/adapters split, ESLint-enforced

## Status
Accepted (2026-04-20).

## Context
Previous factory runs produced four parallel implementations of the same pipeline, each with its own coupling to SDK code. Tests in each implementation were either mock-heavy (brittle) or absent. The cost of that style of coupling in a mid-enterprise service — where we need to swap LLM providers, move from Lambda to Fargate, or run against DynamoDB Local for integration tests — is high enough that a hard boundary earns its keep.

## Decision

- `src/core/` is pure domain. No `@aws-sdk/*`, no `@octokit/*`, no `hono`, no `jose`, no framework imports at all. Enforced by ESLint `no-restricted-imports`.
- `src/adapters/` contains the infrastructure implementations of ports declared in `src/core/ports.ts`.
- `src/api/`, `src/workers/`, `src/handlers/` depend on `Ports` interfaces. They never import adapters directly.
- `src/adapters/compose.ts` is the single composition root for production Ports. Tests construct `Ports` directly from fakes in `tests/fakes.ts`.
- `src/registry.ts` (mirrored from sigint) lets handlers select among multiple adapters for a port (live vs fake).

## Consequences

- Unit tests on `core/` run without Docker, without AWS, without the network. Fast feedback.
- Swapping LLM providers means writing a new `LlmPort` adapter; callers unchanged.
- Integration tests spin real DynamoDB Local and mount real adapters — they test behavior, not a mock.
- ESLint failures when a core/ file accidentally imports SDK code. Boundary is visible in CI, not just in the reviewer's head.
- More files up front (~15 adapter modules). Worth it.

## Alternatives considered
- **Soft split: core/<domain>/ bundles its own adapter.** Less ceremony, but the boundary isn't ESLint-enforceable — regressions creep in.
- **No split, just mock modules in tests.** Brittle. Tests break when internals refactor.
