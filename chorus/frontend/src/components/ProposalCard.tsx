import Link from 'next/link';
import type { ProposalSummary } from '@/lib/api';
import { StatusPill } from './StatusPill';

interface Props {
  proposal: ProposalSummary;
}

function relativeAge(iso: string | null): string {
  if (!iso) return 'unknown';
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / (24 * 60 * 60 * 1000));
  if (days >= 1) return `${days}d ago`;
  const hours = Math.floor(diff / (60 * 60 * 1000));
  if (hours >= 1) return `${hours}h ago`;
  return 'just now';
}

export function ProposalCard({ proposal }: Props) {
  const isLink = proposal.backlogEntryId !== null;
  const preview = proposal.redactedText.slice(0, 280);
  return (
    <article className="card card-interactive">
      <Link
        href={`/proposals/${proposal.id}`}
        className="block outline-none"
        aria-label={`Open proposal from ${proposal.source}, ${isLink ? 'link proposal' : 'new-entry proposal'}`}
      >
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="font-medium">{proposal.source}</span>
          <span className="opacity-60" aria-label={`proposed ${relativeAge(proposal.proposedAt)}`}>
            {relativeAge(proposal.proposedAt)}
          </span>
        </div>
        <p className="mb-3 text-sm leading-relaxed">{preview}</p>
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <StatusPill
            status={proposal.status}
            isLink={isLink}
            proposalScore={proposal.proposalScore}
          />
          {proposal.backlogTitle ? (
            <span className="opacity-70">→ {proposal.backlogTitle}</span>
          ) : (
            <span className="opacity-70">propose new entry</span>
          )}
        </div>
      </Link>
    </article>
  );
}
