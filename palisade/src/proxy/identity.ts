import type { Identity } from "../types/identity.js";
import { sha256Hex } from "../util/hash.js";

/** Extract composite identity from request headers. */
export function extractIdentity(headers: Record<string, string>, remoteIp: string): Identity {
  const ip = headers["x-forwarded-for"]?.split(",")[0]?.trim() || headers["cf-connecting-ip"] || remoteIp || "0.0.0.0";
  const apiKey = headers["authorization"]?.replace(/^bearer\s+/i, "") ?? headers["x-api-key"];
  const workspaceId = headers["x-palisade-workspace-id"];
  const result: Identity = {
    ip,
    ...(apiKey ? { apiKeyHash: sha256Hex(apiKey).slice(0, 32) } : {}),
    ...(workspaceId ? { workspaceId } : {}),
  };
  return result;
}
