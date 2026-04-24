import { createHash } from "node:crypto";

/**
 * Stable SHA-256 hex digest of a rule-change's canonical text. Used
 * as `contentHash` for dedup — two crawler runs that see the same
 * item yield the same hash regardless of ordering metadata (timestamps,
 * feed cursors). Only the semantically meaningful fields feed the hash:
 * title + url + normalized body.
 */
export function hashRuleChange(title: string, url: string, body: string): string {
  const hasher = createHash("sha256");
  hasher.update(title.trim());
  hasher.update("\x1f"); // unit-separator — unambiguous delimiter
  hasher.update(url.trim());
  hasher.update("\x1f");
  hasher.update(body.trim().replace(/\s+/g, " "));
  return hasher.digest("hex");
}
