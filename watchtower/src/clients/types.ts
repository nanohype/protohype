import { z } from "zod";

// ── Per-client configuration ────────────────────────────────────────
//
// Each regulated-entity client has a config row that tells the
// classifier "what does this client care about?". Products ×
// jurisdictions × frameworks form the asymmetry every classifier
// scoring decision is tested against.
//
// Optional notification + publish overrides let a client receive
// alerts in their own Slack workspace and have memos published to
// their own Notion / Confluence, without watchtower holding a
// global identity.
//

export const ClientConfigSchema = z.object({
  clientId: z.string().min(1),
  name: z.string().min(1),
  products: z.array(z.string().min(1)).min(1),
  jurisdictions: z.array(z.string().min(1)).min(1),
  frameworks: z.array(z.string().min(1)).min(1),
  active: z.boolean(),
  notifications: z
    .object({
      slackWebhookUrl: z.string().url().optional(),
      emailRecipients: z.array(z.string().email()).optional(),
    })
    .optional(),
  publish: z
    .object({
      notionDatabaseId: z.string().optional(),
      confluenceSpaceKey: z.string().optional(),
    })
    .optional(),
});

export type ClientConfig = z.infer<typeof ClientConfigSchema>;

/** Read-side port for the per-client config registry. */
export interface ClientsPort {
  /** All clients with `active: true`. Consumed by every classifier invocation. */
  listActive(): Promise<readonly ClientConfig[]>;

  /** Fetch one client by ID, or null if unknown / inactive. */
  get(clientId: string): Promise<ClientConfig | null>;
}
