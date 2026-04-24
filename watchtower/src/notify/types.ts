import { z } from "zod";

// ── Notification contracts ─────────────────────────────────────────
//
// An `Alert` is what the classify handler produces when a rule change
// scores `alert` for a client (or lands in `review` if the operator
// asked to be cc'd on those). The NotifierPort fans the alert out to
// the configured channels (Slack, email, both). Dispatch is
// best-effort — if one channel fails, the other still goes; audit
// gets one event per successful channel.
//

export const AlertSchema = z.object({
  clientId: z.string().min(1),
  clientName: z.string().min(1),
  memoId: z.string().optional(),
  sourceId: z.string(),
  ruleChangeTitle: z.string(),
  ruleChangeUrl: z.string().url(),
  disposition: z.enum(["alert", "review"]),
  score: z.number().int().min(0).max(100),
  rationale: z.string(),
  publishedPageUrl: z.string().url().optional(),
});

export type Alert = z.infer<typeof AlertSchema>;

export interface AlertChannelResult {
  readonly channel: "slack" | "email";
  readonly recipient: string;
  readonly success: boolean;
  readonly error?: string;
}

export interface NotifierPort {
  send(alert: Alert): Promise<readonly AlertChannelResult[]>;
}
