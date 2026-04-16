import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getProposal } from '@/lib/api';
import { StatusPill } from '@/components/StatusPill';
import { ProposalActions } from '@/components/ProposalActions';

interface Props {
  params: Promise<{ id: string }>;
}

export default async function ProposalDetail({ params }: Props) {
  const { id } = await params;
  const proposal = await getProposal(id);
  if (!proposal) notFound();

  const isLink = proposal.backlogEntryId !== null;
  return (
    <div>
      <Link
        href="/"
        className="mb-4 inline-block text-sm opacity-70 hover:opacity-100"
        aria-label="Back to all proposals"
      >
        ← all proposals
      </Link>

      <header className="mb-4">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-sm opacity-60">
          <span>{proposal.source}</span>
          {proposal.sourceUrl ? (
            <a
              className="underline"
              href={proposal.sourceUrl}
              target="_blank"
              rel="noreferrer"
              aria-label="Open original source in new tab"
            >
              source
            </a>
          ) : null}
        </div>
        <h1 className="text-xl font-semibold">
          {isLink ? (proposal.backlogTitle ?? '(missing title)') : 'New feature proposal'}
        </h1>
        <div className="mt-1">
          <StatusPill
            status={proposal.status}
            isLink={isLink}
            proposalScore={proposal.proposalScore}
          />
        </div>
      </header>

      <article className="card" aria-labelledby="evidence-heading">
        <h2 id="evidence-heading" className="mb-2 text-sm font-semibold opacity-70">
          Customer feedback (PII redacted)
        </h2>
        <p className="whitespace-pre-wrap text-sm leading-relaxed">{proposal.redactedText}</p>
      </article>

      {proposal.status === 'pending' ? (
        <ProposalActions proposalId={proposal.id} isLink={isLink} />
      ) : (
        <p className="mt-6 text-sm opacity-70" role="status">
          This proposal is already <strong>{proposal.status}</strong>.
        </p>
      )}
    </div>
  );
}
