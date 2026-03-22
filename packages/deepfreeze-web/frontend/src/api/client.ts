/**
 * API client for the deepfreeze FastAPI backend.
 */

// Auto-detect API URL:
// 1. VITE_API_URL env var if set explicitly
// 2. In production (served by FastAPI), use relative /api path (same origin)
// 3. In dev (Vite on 5173), point to backend on port 8000
function detectApiBase(): string {
  if (import.meta.env.VITE_API_URL) return import.meta.env.VITE_API_URL;
  if (import.meta.env.DEV) {
    return `${window.location.protocol}//${window.location.hostname}:8000/api`;
  }
  return '/api';
}

const API_BASE = detectApiBase();

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

export interface AuditEntry {
  timestamp: string;
  action: string;
  dry_run: boolean;
  success: boolean;
  duration_ms: number;
  parameters: Record<string, unknown>;
  results: Record<string, unknown>[];
  errors: { code: string; message: string }[];
  summary: Record<string, unknown>;
  user: string;
  hostname: string;
  version: string;
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

  getAuditLog: (limit = 50, action?: string) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (action) params.set('action', action);
    return request<{ entries: AuditEntry[]; source: string }>(`/audit?${params}`);
  },

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
