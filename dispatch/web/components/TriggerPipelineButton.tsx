'use client';

/**
 * TriggerPipelineButton — fires an ad-hoc pipeline run from the home page.
 * The dispatch-api enforces approver-only access; the API task role has
 * ecs:RunTask scoped to the pipeline task definition family. The button
 * polls /admin/pipeline-run/:taskArn every 3s while the task is running and
 * surfaces the resulting draftId once the pipeline writes one.
 *
 * Visible to anyone signed in (no client-side approver check) — non-approvers
 * see a clear 403 error if they click. Truth lives on the server.
 */

import { useState, useEffect, useRef } from 'react';

type TriggerState =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'running'; ecsTaskArn: string; startedAt: string }
  | { kind: 'completed'; ecsTaskArn: string; draftId?: string; runId?: string }
  | { kind: 'failed'; message: string };

const POLL_INTERVAL_MS = 3_000;
// Hard cap so a wedged ECS task doesn't poll indefinitely. Pipeline runs
// in the wild take 5-30s; ECS provisioning + container start adds another
// 30-60s on cold-pull. 5 minutes leaves room for both with margin.
const POLL_TIMEOUT_MS = 5 * 60 * 1_000;

export function TriggerPipelineButton() {
  const [state, setState] = useState<TriggerState>({ kind: 'idle' });
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, []);

  const startPolling = (ecsTaskArn: string, startedAt: string) => {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    const poll = async () => {
      if (Date.now() > deadline) {
        setState({ kind: 'failed', message: 'Pipeline did not finish within 5 minutes. Check ECS console for the task status.' });
        return;
      }
      try {
        const res = await fetch(`/api/admin/pipeline-run/${encodeURIComponent(ecsTaskArn)}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setState({ kind: 'failed', message: body.error ?? `Status check failed (HTTP ${res.status})` });
          return;
        }
        const status = await res.json();
        if (status.state === 'running') {
          setState({ kind: 'running', ecsTaskArn, startedAt });
          pollTimer.current = setTimeout(poll, POLL_INTERVAL_MS);
        } else if (status.state === 'completed') {
          // API correlated the finished task back to the draft it wrote
          // (most-recent draft created at or after task.startedAt). Null
          // draftId means the pipeline didn't reach phase.audit_and_notify
          // — rare; would surface in audit_events as PIPELINE_FAILURE.
          setState({ kind: 'completed', ecsTaskArn, draftId: status.draftId, runId: status.runId });
        } else {
          setState({
            kind: 'failed',
            message: `Pipeline task exited ${status.exitCode ?? 'unknown'}: ${status.reason ?? 'no reason given'}`,
          });
        }
      } catch (err) {
        setState({
          kind: 'failed',
          message: err instanceof Error ? err.message : 'Network error while polling pipeline status',
        });
      }
    };
    pollTimer.current = setTimeout(poll, POLL_INTERVAL_MS);
  };

  const handleClick = async () => {
    setState({ kind: 'starting' });
    try {
      const res = await fetch('/api/admin/pipeline-run', { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setState({
          kind: 'failed',
          message: body.error ?? `Trigger failed (HTTP ${res.status})`,
        });
        return;
      }
      const result = await res.json();
      setState({ kind: 'running', ecsTaskArn: result.ecsTaskArn, startedAt: result.startedAt });
      startPolling(result.ecsTaskArn, result.startedAt);
    } catch (err) {
      setState({
        kind: 'failed',
        message: err instanceof Error ? err.message : 'Network error',
      });
    }
  };

  const isWorking = state.kind === 'starting' || state.kind === 'running';

  return (
    <div className="trigger-pipeline">
      <button
        className="trigger-pipeline-button"
        onClick={handleClick}
        disabled={isWorking}
        aria-busy={isWorking}
      >
        {state.kind === 'idle' && 'Trigger pipeline run'}
        {state.kind === 'starting' && 'Starting…'}
        {state.kind === 'running' && 'Running…'}
        {state.kind === 'completed' && 'Trigger another run'}
        {state.kind === 'failed' && 'Try again'}
      </button>
      {state.kind === 'running' && (
        <p className="muted" role="status" aria-live="polite">
          Pipeline started at {new Date(state.startedAt).toLocaleTimeString()}. Polling every {POLL_INTERVAL_MS / 1000}s.
        </p>
      )}
      {state.kind === 'completed' && state.draftId && (
        <p role="status" aria-live="polite">
          Pipeline finished.{' '}
          <a className="trigger-pipeline-link" href={`/review/${state.draftId}`}>
            Review draft &rarr;
          </a>
        </p>
      )}
      {state.kind === 'completed' && !state.draftId && (
        <p role="status" aria-live="polite">
          Pipeline finished but no draft was written. Check{' '}
          <code>/dispatch/&lt;env&gt;/pipeline</code> logs for a PIPELINE_FAILURE.
        </p>
      )}
      {state.kind === 'failed' && (
        <p className="error-banner" role="alert">
          {state.message}
        </p>
      )}
    </div>
  );
}
