import type { Pool } from 'pg';
import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { auditLog, type AuditPort } from '../lib/audit.js';
import type { RedactedText } from './redacted-text.js';
const MATCH_THRESHOLD = parseFloat(process.env.MATCH_THRESHOLD ?? '0.78');
const DUPLICATE_THRESHOLD = 0.85;
export type ProposalType = 'LINK' | 'NEW';
export interface MatchProposal {
  type: ProposalType;
  backlogEntryId?: string;
  similarityScore?: number;
  topCandidates: CandidateEntry[];
  draftTitle?: string;
}
export interface CandidateEntry {
  id: string;
  linearId: string;
  title: string;
  similarityScore: number;
}
export interface MatcherDeps {
  db: Pool;
  bedrockClient: BedrockRuntimeClient;
  generateDraftTitle: (t: RedactedText) => Promise<string>;
  audit?: AuditPort;
}
export async function findMatch(
  correlationId: string,
  feedbackItemId: string,
  embedding: number[],
  feedbackText: RedactedText,
  deps: MatcherDeps,
): Promise<MatchProposal> {
  const { db, generateDraftTitle } = deps;
  const audit = deps.audit ?? auditLog;
  const embeddingLiteral = `[${embedding.join(',')}]`;
  const { rows } = await db.query<{
    id: string;
    linear_id: string;
    title: string;
    distance: number;
  }>(
    'SELECT id, linear_id, title, (embedding <=> $1::vector) AS distance FROM backlog_entries ORDER BY distance ASC LIMIT $2',
    [embeddingLiteral, 5],
  );
  const topCandidates = rows.map((r) => ({
    id: r.id,
    linearId: r.linear_id,
    title: r.title,
    similarityScore: 1 - r.distance,
  }));
  const top = topCandidates[0];
  let proposal: MatchProposal;
  if (top && top.similarityScore >= MATCH_THRESHOLD) {
    proposal = {
      type: 'LINK',
      backlogEntryId: top.id,
      similarityScore: top.similarityScore,
      topCandidates,
    };
  } else {
    const nearDup = topCandidates.find((c) => c.similarityScore >= DUPLICATE_THRESHOLD);
    if (nearDup) {
      proposal = {
        type: 'LINK',
        backlogEntryId: nearDup.id,
        similarityScore: nearDup.similarityScore,
        topCandidates,
      };
    } else {
      const draftTitle = await generateDraftTitle(feedbackText);
      proposal = { type: 'NEW', topCandidates, draftTitle };
    }
  }
  await audit({
    correlationId,
    stage: 'MATCH',
    feedbackItemId,
    backlogEntryId: proposal.backlogEntryId,
    detail: {
      proposalType: proposal.type,
      similarityScore: proposal.similarityScore,
      matchThreshold: MATCH_THRESHOLD,
    },
  });
  return proposal;
}
