import type { Pool } from 'pg';
import { logger } from '../lib/observability.js';
import type { DirectoryUserRecord } from '../lib/directory.js';

/**
 * The Monday 09:00 PT digest. Posts a channel summary to
 * `#product-feedback` and DMs each PM the proposals waiting on their
 * squad. Both posts go through the existing `slack` adapter; this
 * module only computes what to send.
 *
 * Stats (for the channel post):
 *   - Total proposals created in the last 7 days
 *   - LINK vs NEW breakdown
 *   - Top 3 backlog entries by evidence count this week
 *
 * Per-PM DM:
 *   - Pending count visible to the PM's squad ACL
 *   - Top 5 oldest pending proposals (one line each, with a deep link
 *     to the review UI)
 */

export interface WeeklyStats {
  totalProposed: number;
  linkCount: number;
  newCount: number;
  topBacklogEntries: Array<{
    linearId: string;
    title: string;
    evidenceCount: number;
  }>;
}

export interface PendingProposal {
  id: string;
  proposedAt: Date;
  source: string;
  redactedTextSnippet: string;
}

export interface DigestSlackClient {
  postMessage(p: { channel: string; text: string; correlationId?: string }): Promise<void>;
  sendDm(p: { userId: string; text: string; correlationId?: string }): Promise<void>;
}

export interface WeeklyDigestDeps {
  db: Pool;
  slack: DigestSlackClient;
  /** Channel name (with #) to post the public summary into. */
  channel: string;
  /** Base URL of the PM review UI; per-PM DM links are
   *  `${reviewBaseUrl}/proposals/${id}`. */
  reviewBaseUrl: string;
  /** Iterator over PMs (or any user we want to DM). Each user's
   *  `squadIds` and `slackUserId` drive what we send and where. */
  listPms(): Promise<DirectoryUserRecord[]>;
}

export async function postWeeklyDigest(deps: WeeklyDigestDeps): Promise<{
  channelPosted: boolean;
  dmsSent: number;
}> {
  const stats = await fetchWeeklyStats(deps.db);
  const channelMessage = formatChannelMessage(stats);
  await deps.slack.postMessage({ channel: deps.channel, text: channelMessage });
  logger.info('digest channel post sent', {
    channel: deps.channel,
    totalProposed: stats.totalProposed,
  });

  const pms = await deps.listPms();
  let dmsSent = 0;
  for (const pm of pms) {
    if (!pm.slackUserId || pm.squadIds.length === 0) continue;
    const pending = await fetchPendingForSquads(deps.db, pm.squadIds);
    if (pending.length === 0) continue;
    const dmText = formatPmDm(pm.email, pending, deps.reviewBaseUrl);
    try {
      await deps.slack.sendDm({ userId: pm.slackUserId, text: dmText });
      dmsSent += 1;
    } catch (err) {
      // Per-PM DM failures shouldn't kill the whole digest. Channel
      // post already went out; log and move on.
      logger.warn('digest DM failed', { userId: pm.slackUserId, error: String(err) });
    }
  }

  return { channelPosted: true, dmsSent };
}

export async function fetchWeeklyStats(db: Pool): Promise<WeeklyStats> {
  const totalsResult = await db.query<{ total: string; link_count: string; new_count: string }>(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE proposed_entry_id IS NOT NULL) AS link_count,
       COUNT(*) FILTER (WHERE proposed_entry_id IS NULL) AS new_count
     FROM feedback_items
     WHERE proposed_at >= NOW() - INTERVAL '7 days'`,
  );
  const totals = totalsResult.rows[0];

  const topResult = await db.query<{
    linear_id: string;
    title: string;
    evidence_count: string;
  }>(
    `SELECT be.linear_id, be.title, COUNT(fi.id) AS evidence_count
       FROM backlog_entries be
       JOIN feedback_items fi ON fi.proposed_entry_id = be.id
      WHERE fi.proposed_at >= NOW() - INTERVAL '7 days'
      GROUP BY be.id, be.linear_id, be.title
      ORDER BY evidence_count DESC
      LIMIT 3`,
  );

  return {
    totalProposed: parseIntOrZero(totals?.total),
    linkCount: parseIntOrZero(totals?.link_count),
    newCount: parseIntOrZero(totals?.new_count),
    topBacklogEntries: topResult.rows.map((r) => ({
      linearId: r.linear_id,
      title: r.title,
      evidenceCount: parseIntOrZero(r.evidence_count),
    })),
  };
}

export async function fetchPendingForSquads(
  db: Pool,
  squadIds: string[],
  limit = 5,
): Promise<PendingProposal[]> {
  if (squadIds.length === 0) return [];
  const { rows } = await db.query<{
    id: string;
    proposed_at: Date;
    source: string;
    redacted_text: string;
  }>(
    `SELECT DISTINCT fi.id, fi.proposed_at, fi.source, fi.redacted_text
       FROM feedback_items fi
       JOIN raw_evidence re ON re.feedback_item_id = fi.id
      WHERE fi.status = 'pending'
        AND re.acl_squad_ids && $1::text[]
      ORDER BY fi.proposed_at ASC NULLS LAST
      LIMIT $2`,
    [squadIds, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    proposedAt: r.proposed_at,
    source: r.source,
    redactedTextSnippet: r.redacted_text.slice(0, 120),
  }));
}

function formatChannelMessage(stats: WeeklyStats): string {
  const lines = [
    `*Weekly chorus digest* — ${stats.totalProposed} new proposals (${stats.linkCount} LINK / ${stats.newCount} NEW)`,
  ];
  if (stats.topBacklogEntries.length > 0) {
    lines.push('');
    lines.push('*Top backlog entries by evidence this week*');
    for (const e of stats.topBacklogEntries) {
      lines.push(`• ${e.title} — ${e.evidenceCount} new evidence`);
    }
  } else if (stats.totalProposed === 0) {
    lines.push('No proposals this week.');
  }
  return lines.join('\n');
}

function formatPmDm(email: string, pending: PendingProposal[], reviewBaseUrl: string): string {
  const lines = [`Hi! You have ${pending.length} pending chorus proposals to review:`];
  for (const p of pending) {
    const age = humanAge(p.proposedAt);
    lines.push(
      `• [${p.source}, ${age}] ${p.redactedTextSnippet} — <${reviewBaseUrl}/proposals/${p.id}|review>`,
    );
  }
  lines.push('');
  lines.push(`See the full queue at <${reviewBaseUrl}|chorus review>.`);
  return lines.join('\n');
}

function humanAge(d: Date): string {
  if (!d) return 'unknown';
  const diffMs = Date.now() - d.getTime();
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (days >= 1) return `${days}d old`;
  const hours = Math.floor(diffMs / (60 * 60 * 1000));
  return `${hours}h old`;
}

function parseIntOrZero(s: string | undefined): number {
  if (!s) return 0;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}
