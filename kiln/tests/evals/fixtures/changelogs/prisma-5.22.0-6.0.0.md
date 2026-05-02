# Prisma Changelog

## 6.0.0 - 2026-03-04

### Breaking

- **Node.js 16 support removed** — minimum is now Node 18. Affects CI configurations and Dockerfiles.
- **`$queryRaw` returns `BigInt` for `BIGINT` columns** — previously returned `number` with silent precision loss. Apps that compare results with `===` against numeric literals must coerce: `Number(row.id) === 1`.
- **`rejectOnNotFound` client option removed** — use `findUniqueOrThrow` / `findFirstOrThrow`. The option was deprecated in 4.0.
- **`prisma migrate` CLI removed `--create-only` from `deploy`** — use `prisma migrate diff` instead. Affects CI pipelines that relied on the flag.
- **`PrismaClient` constructor option `errorFormat: "colorless"` removed** — use `"minimal"` or `"pretty"`.

### Deprecations

- `@db.UnsupportedType("...")` schema annotation deprecated; still works, removal planned for 7.0.

## 5.22.0 - 2025-09-18

Feature release. No breaking changes.
