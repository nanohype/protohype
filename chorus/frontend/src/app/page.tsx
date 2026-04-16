import { listProposals, type ProposalSummary } from '@/lib/api';
import { ProposalCard } from '@/components/ProposalCard';

export default async function ProposalsPage() {
  let proposals: ProposalSummary[] = [];
  let error: string | null = null;
  try {
    proposals = await listProposals({ limit: 50 });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-xl font-semibold">Pending proposals</h1>
        <p className="text-sm opacity-60">
          Customer feedback the matcher proposes linking — or filing as a new feature.
        </p>
      </header>

      {error ? (
        <div className="alert-danger" role="alert">
          <h2 className="mb-1 text-sm font-semibold text-danger">Could not load proposals</h2>
          <p className="text-sm opacity-80">{error}</p>
        </div>
      ) : proposals.length === 0 ? (
        <div className="alert-muted" role="status">
          No pending proposals visible to your squads.
        </div>
      ) : (
        <ul className="flex flex-col gap-3" role="list">
          {proposals.map((p) => (
            <li key={p.id}>
              <ProposalCard proposal={p} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
