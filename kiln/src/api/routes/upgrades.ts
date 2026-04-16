/**
 * Upgrade API routes — query upgrade status and trigger manual upgrades.
 */
import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware, getIdentity, isPlatformTeam } from "../middleware/auth.js";
import { getTeamConfig, TeamNotFoundError, TeamAccessDeniedError } from "../../db/teams.js";
import { getUpgradeRecord, listUpgradesByTeam } from "../../db/upgrades.js";
import { runUpgradePipeline } from "../../workers/upgrader.js";
import { log } from "../../telemetry/otel.js";
import type { UpgradeSummary } from "../../types.js";

const TriggerSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  dep: z.string().min(1),
  toVersion: z.string().regex(/^\d+\.\d+\.\d+/),
});

export function registerUpgradeRoutes(app: Hono): void {
  const upgrades = new Hono();
  upgrades.use("*", authMiddleware);

  // GET /teams/:teamId/upgrades — list recent upgrades for a team
  upgrades.get("/teams/:teamId/upgrades", async (c) => {
    const teamId = c.req.param("teamId");
    const identity = getIdentity(c);
    const platform = isPlatformTeam(c);

    // ACL check via getTeamConfig — throws TeamAccessDeniedError if unauthorized
    try {
      await getTeamConfig(teamId, identity.teamIds, platform);
    } catch (err) {
      if (err instanceof TeamNotFoundError) return c.json({ error: "Team not found" }, 404);
      if (err instanceof TeamAccessDeniedError) return c.json({ error: "Forbidden" }, 403);
      return c.json({ error: "Internal server error" }, 500);
    }

    const limit = Math.min(Number(c.req.query("limit") ?? "50"), 100);
    const records = await listUpgradesByTeam(teamId, limit);

    const summaries: UpgradeSummary[] = records.map((r) => ({
      upgradeId: r.upgradeId,
      dep: r.dep,
      fromVersion: r.fromVersion,
      toVersion: r.toVersion,
      status: r.status,
      prUrl: r.prUrl,
      breakingChangesCount: r.breakingChanges.length,
      patchedFilesCount: r.patchedFiles.length,
      humanReviewItemsCount: r.humanReviewItems.length,
      createdAt: r.createdAt,
    }));

    return c.json({ upgrades: summaries });
  });

  // GET /teams/:teamId/upgrades/:upgradeId — get full upgrade record
  upgrades.get("/teams/:teamId/upgrades/:upgradeId", async (c) => {
    const teamId = c.req.param("teamId");
    const upgradeId = c.req.param("upgradeId");
    const identity = getIdentity(c);
    const platform = isPlatformTeam(c);

    try {
      await getTeamConfig(teamId, identity.teamIds, platform);
    } catch (err) {
      if (err instanceof TeamNotFoundError) return c.json({ error: "Team not found" }, 404);
      if (err instanceof TeamAccessDeniedError) return c.json({ error: "Forbidden" }, 403);
      return c.json({ error: "Internal server error" }, 500);
    }

    const record = await getUpgradeRecord(teamId, upgradeId);
    if (!record) return c.json({ error: "Upgrade not found" }, 404);

    return c.json(record);
  });

  // POST /teams/:teamId/upgrades — manually trigger an upgrade
  upgrades.post("/teams/:teamId/upgrades", async (c) => {
    const teamId = c.req.param("teamId");
    const identity = getIdentity(c);
    const platform = isPlatformTeam(c);

    let teamConfig;
    try {
      teamConfig = await getTeamConfig(teamId, identity.teamIds, platform);
    } catch (err) {
      if (err instanceof TeamNotFoundError) return c.json({ error: "Team not found" }, 404);
      if (err instanceof TeamAccessDeniedError) return c.json({ error: "Forbidden" }, 403);
      return c.json({ error: "Internal server error" }, 500);
    }

    const body = await c.req.json().catch(() => null);
    const parsed = TriggerSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request body", details: parsed.error.flatten() }, 400);
    }

    const { owner, repo, dep, toVersion } = parsed.data;
    const repoConfig = teamConfig.repos.find((r) => r.owner === owner && r.repo === repo);

    if (!repoConfig) {
      return c.json({ error: `Repo ${owner}/${repo} not found in team config` }, 404);
    }

    if (teamConfig.pinnedSkipList.includes(dep)) {
      return c.json({ error: `${dep} is in the pinned skip list for this team` }, 409);
    }

    // Get current version for fromVersion
    const currentVersion = "0.0.0"; // In production, fetch from repo's package.json

    log("info", "Manual upgrade triggered", { teamId, owner, repo, dep, toVersion });

    // Run inline for v1; production would enqueue to SQS
    const record = await runUpgradePipeline({
      teamId,
      repoConfig,
      dep,
      fromVersion: currentVersion,
      toVersion,
      groupId: null,
    });

    return c.json(record, 202);
  });

  app.route("/", upgrades);
}
