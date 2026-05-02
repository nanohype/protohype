// Maps DomainError discriminants to HTTP responses. Keeps routes terse —
// they can return Results and trust this to handle the conversion.

import type { Context } from "hono";
import type { DomainError } from "../../types.js";

export function domainErrorToHttp(c: Context, error: DomainError): Response {
  switch (error.kind) {
    case "NotFound":
      return c.json({ error: "not_found", detail: error.what }, 404);
    case "Validation":
      return c.json({ error: "validation", detail: error.message, path: error.path }, 400);
    case "Forbidden":
      return c.json({ error: "forbidden", detail: error.message }, 403);
    case "Conflict":
      return c.json({ error: "conflict", detail: error.message }, 409);
    case "RateLimited":
      return c.json({ error: "rate_limited" }, 429);
    case "Timeout":
      return c.json({ error: "upstream_timeout", source: error.source }, 504);
    case "Upstream":
      return c.json({ error: "upstream", source: error.source, status: error.status }, 502);
    case "Internal":
      return c.json({ error: "internal" }, 500);
  }
}
