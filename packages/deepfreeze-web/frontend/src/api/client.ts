/**
 * API client for the deepfreeze FastAPI backend.
 */

// Auto-detect API URL: use env var if set, otherwise same host on port 8000
const API_BASE = import.meta.env.VITE_API_URL ||
  `${window.location.protocol}//${window.location.hostname}:8000/api`;

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(error.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

// -- Status endpoints --

export interface ClusterHealth {
  name: string;
  status: string;
  version: string;
  node_count: number;
}

export interface SystemStatus {
  cluster: ClusterHealth;
  settings: Record<string, unknown> | null;
  repositories: Record<string, unknown>[];
  thaw_requests: Record<string, unknown>[];
  buckets: Record<string, unknown>[];
  ilm_policies: Record<string, unknown>[];
  initialized: boolean;
  errors: { code: string; message: string; severity: string }[];
  timestamp: string;
}

export interface CommandResult {
  success: boolean;
  action: string;
  dry_run: boolean;
  summary: string;
  details: Record<string, unknown>[];
  errors: { code: string; message: string; severity: string }[];
  raw_output: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number;
}

export interface ActionHistoryEntry {
  timestamp: string;
  action: string;
  dry_run: boolean;
  success: boolean;
  summary: string;
  error_count: number;
}

export const api = {
  // Status
  getStatus: (forceRefresh = false) =>
    request<SystemStatus>(`/status?force_refresh=${forceRefresh}`),

  getRepositories: () =>
    request<{ repositories: Record<string, unknown>[] }>('/status/repositories'),

  getThawRequests: () =>
    request<{ thaw_requests: Record<string, unknown>[] }>('/status/thaw-requests'),

  getBuckets: () =>
    request<{ buckets: Record<string, unknown>[] }>('/status/buckets'),

  getIlmPolicies: () =>
    request<{ ilm_policies: Record<string, unknown>[] }>('/status/ilm-policies'),

  getHistory: (limit = 25) =>
    request<{ history: ActionHistoryEntry[] }>(`/history?limit=${limit}`),

  // Actions
  rotate: (params: { year?: number; month?: number; keep?: number; dry_run?: boolean }) =>
    request<CommandResult>('/actions/rotate', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  thawCreate: (params: {
    start_date: string;
    end_date: string;
    duration?: number;
    tier?: string;
    dry_run?: boolean;
  }) =>
    request<CommandResult>('/actions/thaw', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  thawCheck: (requestId?: string) =>
    request<CommandResult>('/actions/thaw/check', {
      method: 'POST',
      body: JSON.stringify({ request_id: requestId }),
    }),

  refreeze: (params: { request_id?: string; dry_run?: boolean }) =>
    request<CommandResult>('/actions/refreeze', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  cleanup: (params: { refrozen_retention_days?: number; dry_run?: boolean }) =>
    request<CommandResult>('/actions/cleanup', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  repair: (params: { dry_run?: boolean }) =>
    request<CommandResult>('/actions/repair', {
      method: 'POST',
      body: JSON.stringify(params),
    }),
};
