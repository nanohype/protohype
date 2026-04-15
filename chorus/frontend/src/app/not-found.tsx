import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="text-center">
      <h1 className="mb-2 text-xl font-semibold">Not found</h1>
      <p className="mb-6 text-sm opacity-70">
        The proposal isn&apos;t visible to your squads, or doesn&apos;t exist.
      </p>
      <Link className="btn btn-secondary" href="/">
        Back to proposals
      </Link>
    </div>
  );
}
