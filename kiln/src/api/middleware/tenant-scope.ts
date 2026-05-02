// Tenant scope guard — any route with `:teamId` in the path must match the
// caller's verified teamId. Belt-and-suspenders: ports already require TeamId,
// but this is the last line of defense if a route handler ever cheats.

import type { Context, MiddlewareHandler } from "hono";

export function tenantScopeMiddleware(): MiddlewareHandler {
  return async (c: Context, next) => {
    const identity = c.get("identity");
    const pathTeamId = c.req.param("teamId");
    if (!identity) {
      return c.json({ error: "unauthorized" }, 401);
    }
    if (pathTeamId && pathTeamId !== identity.teamId) {
      return c.json({ error: "forbidden", detail: "teamId mismatch" }, 403);
    }
    await next();
    return;
  };
}
