/**
 * OAuth 2.0 callback handlers.
 *
 * Security (qa-security requirement):
 * - CSRF: `state` param is a cryptographically random hex token stored in Redis
 *   with 10-min TTL, bound to Slack user ID + source system, deleted on first use.
 * - PKCE: code_verifier/challenge used for Google (S256 method).
 * - State source mismatch -> 400 (prevents cross-source state replay).
 */

import { Router, Request, Response } from "express";
import { randomBytes, createHash } from "crypto";
import Redis from "ioredis";
import axios from "axios";
import { IdentityService, OAuthTokens } from "./identity-service";

const redis = new Redis(process.env.REDIS_URL!);
const STATE_TTL = 600; // 10 minutes
const STATE_PREFIX = "almanac:oauth:state:";
type Source = "notion" | "confluence" | "gdrive";

const CONFIGS: Record<Source, { authUrl: string; tokenUrl: string; scopes: string[]; clientIdEnv: string; clientSecretEnv: string }> = {
  notion: {
    authUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    scopes: ["read_content"],
    clientIdEnv: "NOTION_CLIENT_ID",
    clientSecretEnv: "NOTION_CLIENT_SECRET",
  },
  confluence: {
    authUrl: "https://auth.atlassian.com/authorize",
    tokenUrl: "https://auth.atlassian.com/oauth/token",
    scopes: ["read:confluence-content.all", "offline_access"],
    clientIdEnv: "CONFLUENCE_CLIENT_ID",
    clientSecretEnv: "CONFLUENCE_CLIENT_SECRET",
  },
  gdrive: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/drive.metadata.readonly"],
    clientIdEnv: "GOOGLE_CLIENT_ID",
    clientSecretEnv: "GOOGLE_CLIENT_SECRET",
  },
};

const BASE = process.env.IDENTITY_SERVICE_URL!;

export function createOAuthRouter(identity: IdentityService): Router {
  const router = Router();

  // GET /oauth/:source/start?userId=<slackUserId>
  router.get("/:source/start", async (req: Request, res: Response) => {
    const source = req.params.source as Source;
    const slackUserId = req.query.userId as string;
    if (!CONFIGS[source]) return res.status(400).json({ error: "Unknown source" });
    if (!slackUserId || !/^U[A-Z0-9]+$/.test(slackUserId)) return res.status(400).json({ error: "Invalid userId" });

    const cfg = CONFIGS[source];
    const state = randomBytes(32).toString("hex");
    let codeVerifier: string | undefined;
    let codeChallenge: string | undefined;
    if (source === "gdrive") {
      codeVerifier = randomBytes(32).toString("base64url");
      codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    }

    // Store state in Redis (one-time use, bound to user+source)
    await redis.setex(`${STATE_PREFIX}${state}`, STATE_TTL, JSON.stringify({ slackUserId, source, codeVerifier }));

    const params = new URLSearchParams({
      client_id: process.env[cfg.clientIdEnv]!,
      redirect_uri: `${BASE}/oauth/${source}/callback`,
      response_type: "code",
      scope: cfg.scopes.join(" "),
      state,
      ...(source === "gdrive" ? { access_type: "offline", prompt: "consent", code_challenge: codeChallenge!, code_challenge_method: "S256" } : {}),
      ...(source === "confluence" ? { prompt: "consent", audience: "api.atlassian.com" } : {}),
    });
    return res.redirect(`${cfg.authUrl}?${params}`);
  });

  // GET /oauth/:source/callback?code=...&state=...
  router.get("/:source/callback", async (req: Request, res: Response) => {
    const source = req.params.source as Source;
    const { code, state, error } = req.query as Record<string, string>;

    if (error) return res.status(200).send(page("cancelled", source));
    if (!state || !code) return res.status(400).json({ error: "Missing state or code" });

    // CSRF validation
    const raw = await redis.get(`${STATE_PREFIX}${state}`);
    if (!raw) {
      console.error(`[OAuth][SECURITY] State not found for ${source} -- possible CSRF attempt`);
      return res.status(400).json({ error: "Invalid or expired state" });
    }
    await redis.del(`${STATE_PREFIX}${state}`); // One-time use

    const data = JSON.parse(raw) as { slackUserId: string; source: Source; codeVerifier?: string };
    if (data.source !== source) {
      console.error(`[OAuth][SECURITY] State source mismatch: expected ${data.source}, got ${source}`);
      return res.status(400).json({ error: "State source mismatch" });
    }

    const cfg = CONFIGS[source];
    try {
      const params: Record<string, string> = {
        grant_type: "authorization_code",
        code,
        redirect_uri: `${BASE}/oauth/${source}/callback`,
        client_id: process.env[cfg.clientIdEnv]!,
        client_secret: process.env[cfg.clientSecretEnv]!,
        ...(data.codeVerifier ? { code_verifier: data.codeVerifier } : {}),
      };
      const tokenRes = await axios.post(cfg.tokenUrl, params, { headers: { "Content-Type": "application/x-www-form-urlencoded" } });
      const tokens: OAuthTokens = {
        accessToken: tokenRes.data.access_token,
        refreshToken: tokenRes.data.refresh_token,
        expiresAt: Math.floor(Date.now() / 1000) + (tokenRes.data.expires_in ?? 3600),
        scope: tokenRes.data.scope?.split(" ") ?? cfg.scopes,
      };
      const oktaId = await identity.slackToOkta(data.slackUserId);
      if (!oktaId) return res.status(400).send(page("error", source, "Could not resolve identity"));
      await identity.storeTokens(oktaId, source, tokens);
      console.log(`[OAuth] Connected ${source} for ${oktaId}`);
      return res.status(200).send(page("success", source));
    } catch (err) {
      console.error(`[OAuth] Token exchange failed for ${source}:`, err);
      return res.status(500).send(page("error", source));
    }
  });

  return router;
}

function page(status: "success" | "cancelled" | "error", source: string, msg?: string): string {
  const text = status === "success"
    ? `Connected ${source} successfully! You can close this window.`
    : status === "cancelled"
    ? `${source} connection cancelled.`
    : `Failed to connect ${source}. ${msg ?? "Please try again."}`;
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:2rem"><h2>${text}</h2><script>setTimeout(()=>window.close(),3000)</script></body></html>`;
}
