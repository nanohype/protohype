/**
 * Team configuration API routes.
 * Per-tenant isolation enforced: callers can only read/modify their own team config.
 * Platform team has org-wide visibility.
 */
import { Hono } from "hono";
import { z } from "zod";
import { randomUUID } from "crypto";
import { authMiddleware, getIdentity, isPlatformTeam } from "../middleware/auth.js";
import {
  getTeamConfig,
  putTeamConfig,
  deleteTeamConfig,
  listAccessibleTeamConfigs,
  TeamNotFoundError,
  TeamAccessDeniedError,
} from "../../db/teams.js";
import { log } from "../../telemetry/otel.js";
import type { TeamConfig, GroupingStrategy } from "../../types.js";

const GroupingStrategySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("per-dep") }),
  z.object({ kind: z.literal("per-family"), pattern: z.string().min(1) }),
  z.object({ kind: z.literal("per-release-window"), windowDays: z.number().int().min(1).max(30) }),
]);

const RepoConfigSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  installationId: z.number().int().positive(),
  watchedDeps: z.array(z.string()).min(1),
  defaultBranch: z.string().default("main"),
});

const CreateTeamSchema = z.object({
  orgId: z.string().min(1),
  repos: z.array(RepoConfigSchema).min(1),
  targetVersionPolicy: z.enum(["latest", "minor-only", "patch-only"]).default("latest"),
  reviewSlaDays: z.number().int().min(1).max(90).default(7),
  slackChannel: z.string().nullable().default(null),
  linearProjectId: z.string().nullable().default(null),
  groupingStrategy: GroupingStrategySchema.default({ kind: "per-dep" }),
  pinnedSkipList: z.array(z.string()).default([]),
});

export function registerTeamRoutes(app: Hono): void {
  const teams = new Hono();
  teams.use("*", authMiddleware);

  // GET /teams — list accessible team configs
  teams.get("/", async (c) => {
    const identity = getIdentity(c);
    const platform = isPlatformTeam(c);
    try {
      const configs = await listAccessibleTeamConfigs(identity.teamIds, platform);
      return c.json({ teams: configs });
    } catch (err) {
      log("error", "Failed to list teams", { err: String(err) });
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  // POST /teams — create team config (platform team only)
  teams.post("/", async (c) => {
    if (!isPlatformTeam(c)) {
      return c.json({ error: "Only platform team members can create team configs" }, 403);
    }

    const body = await c.req.json().catch(() => null);
    const parsed = CreateTeamSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request body", details: parsed.error.flatten() }, 400);
    }

    const now = new Date().toISOString();
    const teamId = randomUUID();
    const cfg: TeamConfig = {
      teamId,
      ...parsed.data,
      groupingStrategy: parsed.data.groupingStrategy as GroupingStrategy,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await putTeamConfig(cfg);
      log("info", "Team config created", { teamId });
      return c.json({ teamId, config: cfg }, 201);
    } catch (err) {
      log("error", "Failed to create team config", { err: String(err) });
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  // GET /teams/:teamId — get specific team config
  teams.get("/:teamId", async (c) => {
    const teamId = c.req.param("teamId");
    const identity = getIdentity(c);
    const platform = isPlatformTeam(c);

    try {
      const cfg = await getTeamConfig(teamId, identity.teamIds, platform);
      return c.json(cfg);
    } catch (err) {
      if (err instanceof TeamNotFoundError) return c.json({ error: "Team not found" }, 404);
      if (err instanceof TeamAccessDeniedError) return c.json({ error: "Forbidden" }, 403);
      log("error", "Failed to get team config", { teamId, err: String(err) });
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  // PUT /teams/:teamId — update team config
  teams.put("/:teamId", async (c) => {
    const teamId = c.req.param("teamId");
    const identity = getIdentity(c);
    const platform = isPlatformTeam(c);

    try {
      const existing = await getTeamConfig(teamId, identity.teamIds, platform);

      const body = await c.req.json().catch(() => null);
      const parsed = CreateTeamSchema.partial().safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid request body", details: parsed.error.flatten() }, 400);
      }

      const updated: TeamConfig = {
        ...existing,
        ...parsed.data,
        groupingStrategy: (parsed.data.groupingStrategy as GroupingStrategy | undefined) ?? existing.groupingStrategy,
        updatedAt: new Date().toISOString(),
      };

      await putTeamConfig(updated);
      return c.json(updated);
    } catch (err) {
      if (err instanceof TeamNotFoundError) return c.json({ error: "Team not found" }, 404);
      if (err instanceof TeamAccessDeniedError) return c.json({ error: "Forbidden" }, 403);
      log("error", "Failed to update team config", { teamId, err: String(err) });
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  // DELETE /teams/:teamId
  teams.delete("/:teamId", async (c) => {
    const teamId = c.req.param("teamId");
    const identity = getIdentity(c);
    const platform = isPlatformTeam(c);

    try {
      await deleteTeamConfig(teamId, identity.teamIds, platform);
      return c.json({ deleted: true });
    } catch (err) {
      if (err instanceof TeamNotFoundError) return c.json({ error: "Team not found" }, 404);
      if (err instanceof TeamAccessDeniedError) return c.json({ error: "Forbidden" }, 403);
      log("error", "Failed to delete team config", { teamId, err: String(err) });
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  app.route("/teams", teams);
}
