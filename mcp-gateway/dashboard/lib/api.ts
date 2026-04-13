/**
 * Dashboard API client
 * Reads config.json (deployed by CDK) to discover the API endpoint.
 * Token is stored in localStorage — never baked into the build.
 */

interface DashboardConfig { apiEndpoint: string; region: string; }
let config: DashboardConfig | null = null;

async function getConfig(): Promise<DashboardConfig> {
  if (config) return config;
  if (process.env.NEXT_PUBLIC_API_ENDPOINT) {
    config = { apiEndpoint: process.env.NEXT_PUBLIC_API_ENDPOINT, region: process.env.NEXT_PUBLIC_AWS_REGION ?? 'us-west-2' };
    return config;
  }
  const res = await fetch('/config.json');
  config = await res.json() as DashboardConfig;
  return config;
}

export function getToken(): string {
  if (typeof localStorage === 'undefined') return '';
  return localStorage.getItem('api-token') ?? '';
}

export function setToken(token: string): void {
  localStorage.setItem('api-token', token);
}

export function clearToken(): void {
  localStorage.removeItem('api-token');
}

export function hasToken(): boolean {
  if (typeof localStorage === 'undefined') return false;
  return !!localStorage.getItem('api-token');
}

async function apiFetch<T>(path: string): Promise<T> {
  const cfg = await getConfig();
  const token = getToken();
  if (!token) throw new Error('No API token configured. Enter your token to continue.');
  const res = await fetch(`${cfg.apiEndpoint}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (res.status === 401 || res.status === 403) {
    clearToken();
    throw new Error('Invalid or expired token. Please re-enter your API token.');
  }
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export interface Summary { period: string; totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number; sessionCount: number; agentCount: number; eventCount: number; }
export interface AgentSummary { agentId: string; agentRole?: string; totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number; sessionCount: number; lastActivity: string; }
export interface WorkflowSummary { workflow: string; totalCostUsd: number; agentCount: number; sessionCount: number; }
export interface Session { sessionId: string; agentId: string; totalCostUsd: number; timestamp: string; workflow?: string; }
export interface Budget { daily: { budget: number; spent: number; remaining: number; pct: number; alert: boolean }; monthly: { budget: number; spent: number; remaining: number; pct: number; alert: boolean }; }

export const api = {
  summary: () => apiFetch<Summary>('/dashboard/api/summary'),
  agents: () => apiFetch<{ agents: AgentSummary[] }>('/dashboard/api/agents'),
  agent: (id: string) => apiFetch<{ agentId: string; totalCostUsd: number; sessionCount: number; recentSessions: unknown[] }>(`/dashboard/api/agents/${encodeURIComponent(id)}`),
  workflows: () => apiFetch<{ workflows: WorkflowSummary[] }>('/dashboard/api/workflows'),
  sessions: () => apiFetch<{ sessions: Session[] }>('/dashboard/api/sessions'),
  budget: () => apiFetch<Budget>('/dashboard/api/budget'),
};
