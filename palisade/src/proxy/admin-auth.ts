import type { Context, MiddlewareHandler } from "hono";
import { timingSafeEqual } from "node:crypto";
import { rejectBody } from "./error-response.js";
import { newTraceId } from "../util/hash.js";

export interface AdminAuthOptions {
  /** Expected admin key. If empty/undefined, all admin requests are rejected. */
  readonly apiKey: string | undefined;
}

/**
 * Admin-route auth gate. Accepts the key either as `Authorization: Bearer …`
 * or as `X-Palisade-Admin-Key: …` — whichever the operator prefers. Matches
 * with a constant-time compare so a timing attacker can't walk the key.
 *
 * The reject body uses the same opaque `{ code, trace_id }` shape as the
 * detection-block path so an attacker probing admin routes can't learn the
 * difference between "unauth" and "blocked" from the response shape alone.
 */
export function createAdminAuth(options: AdminAuthOptions): MiddlewareHandler {
  return async (c: Context, next) => {
    if (!options.apiKey) return unauthorized(c);

    const header = c.req.header("authorization") ?? "";
    const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    const xKey = c.req.header("x-palisade-admin-key") ?? "";
    const supplied = bearer || xKey;
    if (!supplied) return unauthorized(c);

    if (!constantTimeEqual(supplied, options.apiKey)) return unauthorized(c);
    await next();
    return;
  };
}

function unauthorized(c: Context): Response {
  const traceId = c.req.header("x-request-id") ?? newTraceId();
  return new Response(JSON.stringify(rejectBody(traceId)), {
    status: 401,
    headers: { "content-type": "application/json", "x-request-id": traceId },
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
