/**
 * ACL Guard: per-user access verification at the retrieval boundary.
 * Called AFTER vector search returns candidates.
 *
 * SECURITY: This is the critical anti-leak boundary. A user must never
 * see content from a doc they cannot access in the source system, even
 * if it scored highly in the index.
 *
 * Fail-secure: missing token, 403/404 from the source, timeout, or
 * network error → `wasRedacted=true`. The document is dropped from the
 * answer and an audit event records the redaction.
 *
 * Tokens are fetched per-user per-source via the `getAccessToken`
 * callback. The callback's contract is "return a valid access token or
 * null"; almanac-oauth's getValidToken() satisfies it by handling
 * refresh-before-expiry transparently.
 *
 * The HTTP client is injected so tests pass `vi.fn<typeof fetch>()`
 * and production passes global `fetch`. No `vi.mock("axios")` or
 * `vi.mock` of the source SDKs anywhere.
 */
import type { RetrievalHit } from "./types.js";
import { AclProbeError, getVerifier } from "./registry.js";
import { logger } from "../logger.js";

// Side-effect imports: each module calls registerVerifier() at load time.
import "./notion.js";
import "./confluence.js";
import "./drive.js";

export type GetAccessToken = (source: RetrievalHit["source"]) => Promise<string | null>;

export interface AclGuardConfig {
  fetchImpl: typeof fetch;
}

export interface AclGuard {
  verify(hits: RetrievalHit[], getAccessToken: GetAccessToken): Promise<RetrievalHit[]>;
}

export function createAclGuard(deps: AclGuardConfig): AclGuard {
  return {
    async verify(hits, getAccessToken) {
      return Promise.all(hits.map((hit) => verifyOne(hit, getAccessToken, deps.fetchImpl)));
    },
  };
}

async function verifyOne(
  hit: RetrievalHit,
  getAccessToken: GetAccessToken,
  fetchImpl: typeof fetch,
): Promise<RetrievalHit> {
  const verifier = getVerifier(hit.source);
  if (!verifier) {
    logger.warn(
      { source: hit.source, docId: hit.docId },
      "no verifier registered for source, redacting",
    );
    return { ...hit, accessVerified: false, wasRedacted: true };
  }
  const token = await getAccessToken(hit.source);
  if (!token) return { ...hit, accessVerified: false, wasRedacted: true };
  try {
    await verifier.probe(hit, token, fetchImpl);
    return { ...hit, accessVerified: true, wasRedacted: false };
  } catch (err: unknown) {
    if (err instanceof AclProbeError && (err.status === 403 || err.status === 404)) {
      return { ...hit, accessVerified: false, wasRedacted: true };
    }
    logger.warn(
      { err, docId: hit.docId, source: hit.source },
      "ACL probe non-auth error, fail-secure",
    );
    return { ...hit, accessVerified: false, wasRedacted: true };
  }
}
