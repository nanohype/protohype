// Auth middleware — verifies the bearer token via the IdentityPort and stashes
// the VerifiedIdentity on the context. Downstream handlers READ but never
// forge identity.

import type { Context, MiddlewareHandler } from "hono";
import type { IdentityPort } from "../../core/ports.js";
import type { VerifiedIdentity } from "../../types.js";

export interface AuthContext {
  identity: VerifiedIdentity;
}

declare module "hono" {
  interface ContextVariableMap {
    identity: VerifiedIdentity;
  }
}

export function authMiddleware(identity: IdentityPort): MiddlewareHandler {
  return async (c: Context, next) => {
    const header = c.req.header("authorization") ?? "";
    const result = await identity.verifyBearer(header);
    if (!result.ok) {
      return c.json({ error: "unauthorized", detail: result.error.message }, 401);
    }
    c.set("identity", result.value);
    await next();
    return;
  };
}
