import { z } from "zod";

/**
 * Grouping strategy — mirrors Renovate groupName config.
 */
export const GroupingStrategySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("per-dep") }),
  z.object({
    type: z.literal("per-family"),
    pattern: z.string().min(1),
  }),
  z.object({
    type: z.literal("per-release-window"),
    windowDays: z.number().int().min(1).max(90),
  }),
]);

/**
 * Target-version policy: which version stream to upgrade to.
 */
export const TargetVersionPolicySchema = z.union([
  z.literal("latest"), // latest dist-tag on npm
  z.literal("latest-minor"), // latest patch within current major.minor
  z.literal("latest-patch"), // latest patch only (same major.minor)
  z.object({
    pinned: z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/),
  }), // exact pinned version
]);

/**
 * Per-team Kiln configuration.
 * Lives in DynamoDB, scoped by teamId (partition key).
 */
export const TeamConfigSchema = z.object({
  teamId: z.string().min(1).max(64),
  orgId: z.string().min(1).max(64),

  /** GitHub repos this team owns — Kiln watches these for dep updates */
  watchedRepos: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/)).min(1),

  /** Target-version policy applied across all watched repos unless overridden per-dep */
  targetVersionPolicy: TargetVersionPolicySchema.default("latest"),

  /** PR review SLA in hours — Kiln alerts if PR is not reviewed within this window */
  reviewSlaTtlHours: z.number().int().min(1).max(720).default(168), // 7d default

  /** Slack channel to notify on new Kiln PRs and SLA breaches */
  slackChannel: z.string().regex(/^#[\w-]+$/).optional(),

  /** Deps to never upgrade automatically (name or name@version) */
  pinnedSkipList: z.array(z.string()).default([]),

  /** PR grouping strategy */
  groupingStrategy: GroupingStrategySchema.default({ type: "per-dep" }),

  /** Linear project ID for filing issues when breaking changes need human judgment */
  linearProjectId: z.string().optional(),

  /** Whether Kiln is enabled for this team */
  enabled: z.boolean().default(true),

  /** ISO-8601 timestamp of last config update */
  updatedAt: z.string().optional(),
});

export type TeamConfig = z.infer<typeof TeamConfigSchema>;
export type GroupingStrategyConfig = z.infer<typeof GroupingStrategySchema>;
export type TargetVersionPolicy = z.infer<typeof TargetVersionPolicySchema>;

/**
 * Parse and validate a raw config object. Returns either the validated config
 * or a structured error listing all validation failures.
 */
export function parseTeamConfig(raw: unknown):
  | { ok: true; config: TeamConfig }
  | { ok: false; errors: string[] } {
  const result = TeamConfigSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, config: result.data };
  }
  const errors = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  return { ok: false, errors };
}

/**
 * Check whether a dep name is in the team's pinnedSkipList.
 * Matches on exact name OR name@version prefix.
 */
export function isSkipped(depName: string, skipList: string[]): boolean {
  return skipList.some((entry) => {
    if (entry.includes("@", 1)) {
      // name@version — match only the name portion
      return entry.startsWith(`${depName}@`);
    }
    return entry === depName;
  });
}
