import { z } from "zod";

export const WatchedRepoSchema = z.object({
  fullName: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/, "Must be owner/repo format"),
  installationId: z.number().int().positive(),
  defaultBranch: z.string().min(1).default("main"),
  enabled: z.boolean().default(true),
});

export const DepFamilyPatternSchema = z.object({
  pattern: z.string().min(1, "Pattern is required"),
  label: z.string().min(1, "Label is required"),
});

export const TeamConfigSchema = z.object({
  teamId: z.string().min(1),
  teamName: z.string().min(1),
  watchedRepos: z.array(WatchedRepoSchema),
  groupingStrategy: z.enum(["per-dep", "per-family", "per-release-window"]),
  familyPatterns: z.array(DepFamilyPatternSchema),
  releaseWindowCron: z.string().optional(),
  targetVersionPolicy: z.enum(["latest-stable", "lts", "pinned"]),
  reviewSlaDays: z.number().int().min(1).max(90),
  slackChannelId: z.string().optional(),
  skipList: z.array(z.string()),
});

/** Used in the onboarding wizard to add a single repo */
export const AddRepoSchema = z.object({
  fullName: z
    .string()
    .regex(
      /^[\w.-]+\/[\w.-]+$/,
      "Must be in owner/repo format (e.g. acme/my-app)"
    ),
  installationId: z.number().int().positive("Must be a positive integer"),
  defaultBranch: z.string().min(1).default("main"),
});

export type AddRepoFormData = z.infer<typeof AddRepoSchema>;

export const NotificationSettingsSchema = z.object({
  slackChannelId: z
    .string()
    .regex(/^C[A-Z0-9]{8,}$/, "Must be a valid Slack channel ID (starts with C)")
    .optional()
    .or(z.literal("")),
  reviewSlaDays: z.coerce.number().int().min(1).max(90),
});

export type NotificationSettingsFormData = z.infer<
  typeof NotificationSettingsSchema
>;

export const GroupingSettingsSchema = z
  .object({
    groupingStrategy: z.enum(["per-dep", "per-family", "per-release-window"]),
    familyPatterns: z.array(DepFamilyPatternSchema),
    releaseWindowCron: z.string().optional(),
  })
  .refine(
    (d) =>
      d.groupingStrategy !== "per-family" || d.familyPatterns.length > 0,
    {
      message:
        "At least one family pattern is required for 'per-family' grouping",
      path: ["familyPatterns"],
    }
  );

export type GroupingSettingsFormData = z.infer<typeof GroupingSettingsSchema>;
