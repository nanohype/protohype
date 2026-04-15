interface Props {
  status: string;
  isLink: boolean;
  proposalScore: number | null;
}

export function StatusPill({ status, isLink, proposalScore }: Props) {
  const typeLabel = isLink
    ? `link proposal${proposalScore !== null ? `, similarity ${(proposalScore * 100).toFixed(0)} percent` : ''}`
    : 'new entry proposal';
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`pill ${isLink ? 'pill-link' : 'pill-new'}`} aria-label={typeLabel}>
        {isLink
          ? `LINK${proposalScore !== null ? ` · ${(proposalScore * 100).toFixed(0)}%` : ''}`
          : 'NEW'}
      </span>
      {status !== 'pending' ? (
        <span className="pill" aria-label={`status: ${status}`}>
          {status}
        </span>
      ) : null}
    </span>
  );
}
