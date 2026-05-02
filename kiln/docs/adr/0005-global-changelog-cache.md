# ADR 0005 — Changelog cache is global, not per-tenant

## Status
Accepted (2026-04-20).

## Context
kiln's operating invariant is "every DynamoDB query scoped on `teamId`." The `kiln-changelog-cache` table breaks that — it's keyed on `cacheKey` (e.g., `react@19.0.0`) with no `teamId` component.

This came up in the architecture stress-test: is it a security bug?

## Decision
The exception is intentional. Changelog bodies are **public data** pulled from `github.com` and `registry.npmjs.org`. Two tenants upgrading the same package to the same version would both fetch the same public bytes. Partitioning the cache by tenant would N-x the storage and HTTP fetches for no security benefit.

## Consequences

- Cache key is `pkg@version`. No tenant attribution.
- 7-day TTL via DDB TTL attribute.
- Threat-model annotation: an attacker with read access to `kiln-changelog-cache` learns which packages kiln has classified. That's not sensitive; the package list is visible via PRs in public repos anyway.
- IAM: workers have `GetItem`/`PutItem` on this table.

## Alternatives considered
- **Partition by tenant.** Wasteful; same public data duplicated.
- **Skip the cache entirely.** npm/GitHub rate-limit us into oblivion on popular packages.

## Boundary condition
If kiln ever adds support for **private npm registries** or **private GitHub repos with private changelogs**, this decision needs to be revisited. At that point, the cache key must include a tenant scope — or a separate `private-changelog-cache` table partitioned per tenant must be added.
