# Next.js Changelog

## 15.0.0 - 2026-02-11

### Breaking

- **`cookies()`, `headers()`, `draftMode()`, `searchParams` are now async** — must be `await`ed in Server Components and Route Handlers. Synchronous access throws in development; silently returns a Promise in production (type system will catch most sites).
- **`fetch` defaults changed to `cache: "no-store"`** — previously defaulted to `force-cache`. Apps that relied on implicit caching must opt in with `cache: "force-cache"` or `next: { revalidate: 60 }`.
- **`next/image` `domains` config removed** — use `remotePatterns` instead. Was deprecated in 13.
- **Node.js 18 support dropped** — minimum is now Node 20.
- **`experimental.serverActions` flag removed** — Server Actions are stable; config no longer accepts the key.

### Deprecations

- `next/legacy/image` marked deprecated; will be removed in 16.

## 14.2.0 - 2025-07-22

Feature release. No breaking changes.
