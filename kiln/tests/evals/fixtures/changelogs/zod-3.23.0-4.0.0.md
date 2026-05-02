# Zod Changelog

## 4.0.0 - 2026-02-20

Zod 4 is a rewrite of the validator pipeline focused on performance and stricter TypeScript inference. Most schemas continue to work; a few surface changes require code migration.

### Breaking

- **`z.string().nonempty()` removed** — use `z.string().min(1)`. Behavior is identical; the alias was redundant.
- **`.refine()` no longer accepts a second-positional error string** — pass `{ message: "..." }` as the second argument instead. Inline strings throw at parse time in 4.x.
- **`ZodError.issues[i].path` is now `readonly`** — cloning the error to mutate it will break. Use `.flatten()` or `.format()` instead.
- **`z.record(valueSchema)` now requires a key schema** — `z.record(z.string(), z.number())` instead of `z.record(z.number())`. The single-argument form is removed.
- **`.parse()` on a `ZodDefault` with `undefined` input applies the default** — in 3.x, the default was applied for `undefined` AND `null`. Code that relied on null-becoming-default must handle null explicitly.

### Deprecations

- `z.preprocess` marked deprecated in favor of `z.pipe(z.transform(...), schema)`. Still works in 4.x; will be removed in 5.

### New

- `z.branded<Brand>()` with symbol-backed brand type — non-breaking.

## 3.23.0 - 2025-08-11

Feature release. No breaking changes.
