import { withAuth } from './auth';

const BASE_URL = process.env['CHORUS_API_BASE_URL'] ?? 'http://localhost:3000';

export interface ProposalSummary {
  id: string;
  correlationId: string;
  source: string;
  sourceUrl: string | null;
  redactedText: string;
  proposedAt: string | null;
  proposalScore: number | null;
  status: string;
  backlogEntryId: string | null;
  linearId: string | null;
  backlogTitle: string | null;
}

interface ApiError extends Error {
  status: number;
}

async function authToken(): Promise<string> {
  if (process.env['NODE_ENV'] !== 'production' && process.env['CHORUS_DEV_BEARER']) {
    return process.env['CHORUS_DEV_BEARER'];
  }
  const { accessToken } = await withAuth();
  if (!accessToken) {
    const err = new Error('Not authenticated') as ApiError;
    err.status = 401;
    throw err;
  }
  return accessToken;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await authToken();
  const r = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    cache: 'no-store',
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    const err = new Error(`chorus API ${r.status}: ${text || r.statusText}`) as ApiError;
    err.status = r.status;
    throw err;
  }
  if (r.status === 204) return undefined as T;
  return (await r.json()) as T;
}

export async function listProposals(opts: { limit?: number } = {}): Promise<ProposalSummary[]> {
  const params = new URLSearchParams();
  if (opts.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  const r = await api<{ proposals: ProposalSummary[] }>(`/api/proposals${qs ? `?${qs}` : ''}`);
  return r.proposals;
}

export async function getProposal(id: string): Promise<ProposalSummary | null> {
  try {
    const r = await api<{ proposal: ProposalSummary }>(`/api/proposals/${encodeURIComponent(id)}`);
    return r.proposal;
  } catch (err) {
    if ((err as ApiError).status === 404) return null;
    throw err;
  }
}

export async function approveProposal(
  id: string,
  body: { newTitle?: string } = {},
): Promise<ProposalSummary> {
  const r = await api<{ proposal: ProposalSummary }>(
    `/api/proposals/${encodeURIComponent(id)}/approve`,
    { method: 'POST', body: JSON.stringify(body) },
  );
  return r.proposal;
}

export async function rejectProposal(id: string, reason?: string): Promise<ProposalSummary> {
  const r = await api<{ proposal: ProposalSummary }>(
    `/api/proposals/${encodeURIComponent(id)}/reject`,
    { method: 'POST', body: JSON.stringify({ reason }) },
  );
  return r.proposal;
}

export async function deferProposal(id: string, reason?: string): Promise<ProposalSummary> {
  const r = await api<{ proposal: ProposalSummary }>(
    `/api/proposals/${encodeURIComponent(id)}/defer`,
    { method: 'POST', body: JSON.stringify({ reason }) },
  );
  return r.proposal;
}
