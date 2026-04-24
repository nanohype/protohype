import { z } from "zod";
import { RuleChangeSchema } from "../crawlers/types.js";

// ── Stage message envelopes ────────────────────────────────────────
//
// Each SQS queue carries messages validated by one of these schemas.
// Handlers parse their own input at the boundary via Zod — never
// trust what SQS delivers without re-validating.
//

export const CrawlJob = z.object({
  source: z.string().min(1),
});
export type CrawlJob = z.infer<typeof CrawlJob>;

export const ClassifyJob = z.object({
  clientId: z.string().min(1),
  ruleChange: RuleChangeSchema,
});
export type ClassifyJob = z.infer<typeof ClassifyJob>;

export const PublishJob = z.object({
  memoId: z.string().min(1),
  clientId: z.string().min(1),
});
export type PublishJob = z.infer<typeof PublishJob>;
