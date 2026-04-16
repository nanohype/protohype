/**
 * Kiln API client — typed fetch wrapper for the Kiln backend.
 *
 * All calls go through `kilnFetch` which:
 *   - Enforces an explicit per-call timeout (10s default)
 *   - Attaches the correlation / request ID header
 *   - Surfaces ApiError for non-2xx responses
 *   - Never exposes raw fetch to callers — all paths return typed data
 */

import type {
  KilnPR,
  PaginatedResponse,
  TeamConfig,
  TeamMetrics,
  WatchedRepo,
} from "@/types";

const BASE_URL =
  process.env.NEXT_PUBLIC_KILN_API_URL ?? "http://localhost:3001";

/** Default per-call timeout in ms. */
const DEFAULT_TIMEOUT_MS = 10_000;

export class KilnApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly requestId: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "KilnApiError";
  }
}

async function kilnFetch<T>(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...fetchInit } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const requestId = crypto.randomUUID();

  try {
    const resp = await fetch(`${BASE_URL}${path}`, {
      ...fetchInit,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Request-Id": requestId,
        ...fetchInit.headers,
      },
    });

    if (!resp.ok) {
      let body: { code?: string; message?: string } = {};
      try {
        body = await resp.json();
      } catch {
        // ignore parse failure; use defaults below
      }
      throw new KilnApiError(
        body.code ?? "UNKNOWN",
        body.message ?? `HTTP ${resp.status}`,
        requestId,
        resp.status
      );
    }

    return resp.json() as Promise<T>;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Team Config ──────────────────────────────────────────────────────────────

export async function getTeamConfig(
  teamId: string,
  sessionToken: string
): Promise<TeamConfig> {
  return kilnFetch<TeamConfig>(`/api/v1/teams/${encodeURIComponent(teamId)}/config`, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
}

export async function updateTeamConfig(
  teamId: string,
  patch: Partial<TeamConfig>,
  sessionToken: string
): Promise<TeamConfig> {
  return kilnFetch<TeamConfig>(`/api/v1/teams/${encodeURIComponent(teamId)}/config`, {
    method: "PATCH",
    body: JSON.stringify(patch),
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
}

// ─── Repos ────────────────────────────────────────────────────────────────────

export async function addWatchedRepo(
  teamId: string,
  repo: Pick<WatchedRepo, "fullName" | "installationId" | "defaultBranch">,
  sessionToken: string
): Promise<WatchedRepo> {
  return kilnFetch<WatchedRepo>(
    `/api/v1/teams/${encodeURIComponent(teamId)}/repos`,
    {
      method: "POST",
      body: JSON.stringify(repo),
      headers: { Authorization: `Bearer ${sessionToken}` },
    }
  );
}

export async function removeWatchedRepo(
  teamId: string,
  repoFullName: string,
  sessionToken: string
): Promise<void> {
  return kilnFetch<void>(
    `/api/v1/teams/${encodeURIComponent(teamId)}/repos/${encodeURIComponent(repoFullName)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${sessionToken}` },
    }
  );
}

// ─── PRs ──────────────────────────────────────────────────────────────────────

export async function listTeamPRs(
  teamId: string,
  sessionToken: string,
  opts: { cursor?: string; limit?: number; status?: string } = {}
): Promise<PaginatedResponse<KilnPR>> {
  const params = new URLSearchParams();
  if (opts.cursor) params.set("cursor", opts.cursor);
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.status) params.set("status", opts.status);

  return kilnFetch<PaginatedResponse<KilnPR>>(
    `/api/v1/teams/${encodeURIComponent(teamId)}/prs?${params.toString()}`,
    { headers: { Authorization: `Bearer ${sessionToken}` } }
  );
}

export async function getPR(
  teamId: string,
  prId: string,
  sessionToken: string
): Promise<KilnPR> {
  return kilnFetch<KilnPR>(
    `/api/v1/teams/${encodeURIComponent(teamId)}/prs/${encodeURIComponent(prId)}`,
    { headers: { Authorization: `Bearer ${sessionToken}` } }
  );
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

export async function getTeamMetrics(
  teamId: string,
  sessionToken: string,
  windowDays = 30
): Promise<TeamMetrics> {
  return kilnFetch<TeamMetrics>(
    `/api/v1/teams/${encodeURIComponent(teamId)}/metrics?windowDays=${windowDays}`,
    { headers: { Authorization: `Bearer ${sessionToken}` } }
  );
}
