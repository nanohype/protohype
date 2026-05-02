import type { Hono } from "hono";
import { z } from "zod";
import type { Ports } from "../../core/ports.js";
import { asInstallationId, asTeamId } from "../../types.js";
import { domainErrorToHttp } from "../middleware/error-mapper.js";

const repoConfigSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  installationId: z.number().int().positive(),
  watchedDeps: z.array(z.string().min(1)),
});

const groupingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("per-dep") }),
  z.object({ kind: z.literal("per-family"), pattern: z.string().min(1) }),
  z.object({ kind: z.literal("per-release-window"), windowDays: z.number().int().positive() }),
]);

const teamConfigSchema = z.object({
  orgId: z.string().min(1),
  repos: z.array(repoConfigSchema),
  targetVersionPolicy: z.enum(["latest", "minor-only", "patch-only"]),
  reviewSlaDays: z.number().int().positive(),
  slackChannel: z.string().nullable(),
  linearProjectId: z.string().nullable(),
  groupingStrategy: groupingSchema,
  pinnedSkipList: z.array(z.string()),
});

export function registerTeamRoutes(app: Hono, ports: Ports): void {
  app.get("/teams/:teamId", async (c) => {
    const teamId = asTeamId(c.req.param("teamId"));
    const result = await ports.teamConfig.get(teamId);
    if (!result.ok) return domainErrorToHttp(c, result.error);
    if (!result.value) return c.json({ error: "not_found" }, 404);
    return c.json(result.value);
  });

  app.put("/teams/:teamId", async (c) => {
    const teamId = asTeamId(c.req.param("teamId"));
    const body = teamConfigSchema.safeParse(await c.req.json());
    if (!body.success) {
      return c.json({ error: "validation", issues: body.error.issues }, 400);
    }
    const now = new Date().toISOString();
    const repos = body.data.repos.map((r) => ({
      ...r,
      installationId: asInstallationId(r.installationId),
    }));
    const result = await ports.teamConfig.put({
      teamId,
      orgId: body.data.orgId,
      repos,
      targetVersionPolicy: body.data.targetVersionPolicy,
      reviewSlaDays: body.data.reviewSlaDays,
      slackChannel: body.data.slackChannel,
      linearProjectId: body.data.linearProjectId,
      groupingStrategy: body.data.groupingStrategy,
      pinnedSkipList: body.data.pinnedSkipList,
      createdAt: now,
      updatedAt: now,
    });
    if (!result.ok) return domainErrorToHttp(c, result.error);
    return c.json({ ok: true });
  });

  app.delete("/teams/:teamId", async (c) => {
    const teamId = asTeamId(c.req.param("teamId"));
    const result = await ports.teamConfig.delete(teamId);
    if (!result.ok) return domainErrorToHttp(c, result.error);
    return c.json({ ok: true });
  });
}
