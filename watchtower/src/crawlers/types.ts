import { z } from "zod";

// ── Crawler contracts ──────────────────────────────────────────────
//
// A `Crawler` represents one regulator source feed (SEC EDGAR, CFPB,
// OFAC, EDPB, etc). `crawl()` returns every change the crawler knows
// about; the dedup layer (see `./dedup.ts`) decides which are new
// enough to emit downstream.
//
// `RuleChange` is the canonical envelope that travels through the
// classify → memo → publish stages. Source-specific detail rides
// along in `rawMetadata` and is passed to the classifier prompt so
// subtle signals (effective dates, docket numbers, agency sub-bureau)
// reach the LLM even if the crawler's summary doesn't surface them.
//

export const RuleChangeSchema = z.object({
  sourceId: z.string().min(1),
  contentHash: z.string().min(1),
  title: z.string().min(1),
  url: z.string().url(),
  publishedAt: z.string().datetime(),
  summary: z.string(),
  body: z.string(),
  rawMetadata: z.record(z.string(), z.unknown()).default({}),
});

export type RuleChange = z.infer<typeof RuleChangeSchema>;

export interface Crawler {
  readonly sourceId: string;
  crawl(): Promise<readonly RuleChange[]>;
}

/** Seen/unseen tracking for (sourceId, contentHash) pairs. */
export interface DedupPort {
  /** Return true if this (source, hash) has already been emitted. */
  seen(sourceId: string, contentHash: string): Promise<boolean>;

  /** Record a (source, hash) as emitted; idempotent on duplicate calls. */
  markSeen(
    sourceId: string,
    contentHash: string,
    meta: { url: string; title: string; firstSeenAt: string },
  ): Promise<void>;
}
