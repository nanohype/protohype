import type { Hono } from "hono";
import type { Ports } from "../../core/ports.js";
import { asTeamId } from "../../types.js";
import { domainErrorToHttp } from "../middleware/error-mapper.js";

export function registerUpgradeRoutes(app: Hono, ports: Ports): void {
  app.get("/teams/:teamId/upgrades", async (c) => {
    const teamId = asTeamId(c.req.param("teamId"));
    const limit = Math.min(Number(c.req.query("limit") ?? "50"), 200);
    const result = await ports.prLedger.listRecent(teamId, limit);
    if (!result.ok) return domainErrorToHttp(c, result.error);
    return c.json({ items: result.value });
  });
}
