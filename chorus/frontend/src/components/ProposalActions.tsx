'use client';

import { useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  proposalId: string;
  isLink: boolean;
}

export function ProposalActions({ proposalId, isLink }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [reasonReject, setReasonReject] = useState('');
  const [reasonDefer, setReasonDefer] = useState('');

  const newTitleId = useId();
  const reasonRejectId = useId();
  const reasonDeferId = useId();
  const errorId = useId();

  function call(action: 'approve' | 'reject' | 'defer', body: Record<string, unknown>) {
    setError(null);
    startTransition(async () => {
      const r = await fetch(`/proposals/${proposalId}/actions/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        setError(text || `request failed (${r.status})`);
        return;
      }
      router.push('/');
      router.refresh();
    });
  }

  const approveDisabled = pending || (!isLink && newTitle.trim().length === 0);

  return (
    <section
      aria-label="Proposal actions"
      aria-busy={pending}
      className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3"
    >
      <fieldset className="card" disabled={pending}>
        <legend className="mb-2 text-sm font-semibold">Approve</legend>
        {!isLink && (
          <>
            <label htmlFor={newTitleId} className="mb-1 block text-xs opacity-70">
              New feature title (required)
            </label>
            <input
              id={newTitleId}
              className="field-input mb-2"
              placeholder="e.g. CSV export in admin dashboard"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              required
              aria-required="true"
            />
          </>
        )}
        <button
          type="button"
          className="btn btn-primary w-full"
          disabled={approveDisabled}
          aria-disabled={approveDisabled}
          onClick={() => call('approve', isLink ? {} : { newTitle: newTitle.trim() })}
        >
          {pending ? 'Working…' : isLink ? 'Approve link' : 'Create feature'}
        </button>
      </fieldset>

      <fieldset className="card" disabled={pending}>
        <legend className="mb-2 text-sm font-semibold">Reject</legend>
        <label htmlFor={reasonRejectId} className="mb-1 block text-xs opacity-70">
          Reason (optional)
        </label>
        <input
          id={reasonRejectId}
          className="field-input mb-2"
          placeholder="e.g. duplicate of PRD-42"
          value={reasonReject}
          onChange={(e) => setReasonReject(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-danger w-full"
          disabled={pending}
          aria-disabled={pending}
          onClick={() => call('reject', { reason: reasonReject || undefined })}
        >
          {pending ? 'Working…' : 'Reject'}
        </button>
      </fieldset>

      <fieldset className="card" disabled={pending}>
        <legend className="mb-2 text-sm font-semibold">Defer</legend>
        <label htmlFor={reasonDeferId} className="mb-1 block text-xs opacity-70">
          Reason (optional)
        </label>
        <input
          id={reasonDeferId}
          className="field-input mb-2"
          placeholder="e.g. revisit next quarter"
          value={reasonDefer}
          onChange={(e) => setReasonDefer(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-secondary w-full"
          disabled={pending}
          aria-disabled={pending}
          onClick={() => call('defer', { reason: reasonDefer || undefined })}
        >
          {pending ? 'Working…' : 'Defer'}
        </button>
      </fieldset>

      {error ? (
        <p id={errorId} role="alert" className="text-sm text-danger sm:col-span-3">
          {error}
        </p>
      ) : null}
    </section>
  );
}
