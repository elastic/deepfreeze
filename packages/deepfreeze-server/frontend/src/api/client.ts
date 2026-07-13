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

// -- Auth token management --
//
// Default (no "remember me"): the token lives in sessionStorage and is cleared
// when the browser/tab closes. With "remember me": the token is persisted in a
// cookie that outlives the browser session (expiry matches the server session
// TTL), so the user isn't re-prompted for credentials on every browser restart.
// The token is always sent to the server via the Authorization header; the
// cookie is just client-side persistence (not read by the server).

const TOKEN_KEY = 'deepfreeze-auth-token';
const DEFAULT_REMEMBER_MAX_AGE = 30 * 24 * 60 * 60; // 30 days

function setCookie(name: string, value: string, maxAgeSeconds: number) {
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie =
    `${name}=${encodeURIComponent(value)}; Max-Age=${maxAgeSeconds}; Path=/; SameSite=Strict${secure}`;
}

function getCookie(name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = document.cookie.match(new RegExp('(?:^|; )' + escaped + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

function deleteCookie(name: string) {
  document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Strict`;
}

// On load, prefer a remembered (cookie) token, then a session token.
let _authToken: string | null = getCookie(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);
let _onAuthError: (() => void) | null = null;

export function setAuthToken(
  token: string | null,
  options: { remember?: boolean; maxAgeSeconds?: number } = {},
) {
  _authToken = token;
  if (!token) {
    sessionStorage.removeItem(TOKEN_KEY);
    deleteCookie(TOKEN_KEY);
    return;
  }
  if (options.remember) {
    setCookie(TOKEN_KEY, token, options.maxAgeSeconds ?? DEFAULT_REMEMBER_MAX_AGE);
    sessionStorage.removeItem(TOKEN_KEY);
  } else {
    sessionStorage.setItem(TOKEN_KEY, token);
    deleteCookie(TOKEN_KEY);
  }
}

export function getAuthToken(): string | null {
  return _authToken;
}

export function onAuthError(cb: () => void) {
  _onAuthError = cb;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string>),
  };
  if (_authToken) {
    headers['Authorization'] = `Bearer ${_authToken}`;
  }
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (res.status === 401 && !path.startsWith('/auth/')) {
    _onAuthError?.();
    throw new Error('Session expired');
  }
  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(error.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

// -- Auth endpoints --

export interface LoginResponse {
  token: string;
  username: string;
  expires_in: number;
}

export interface UserInfo {
  username: string;
  authenticated: boolean;
}

export async function login(
  credentials: { username: string; password: string } | { api_key: string },
  remember = false,
): Promise<LoginResponse> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...credentials, remember }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(error.detail || 'Login failed');
  }
  const data: LoginResponse = await res.json();
  // Persist per "remember me"; align cookie lifetime with the server session TTL.
  setAuthToken(data.token, { remember, maxAgeSeconds: data.expires_in });
  return data;
}

export async function logout(): Promise<void> {
  try {
    await request('/auth/logout', { method: 'POST' });
  } catch {
    // ignore — we're logging out regardless
  }
  setAuthToken(null);
}

export async function checkSession(): Promise<UserInfo | null> {
  if (!_authToken) return null;
  try {
    return await request<UserInfo>('/auth/me');
  } catch {
    setAuthToken(null);
    return null;
  }
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

export interface RestoreProgress {
  repo: string;
  total: number;
  restored: number;
  in_progress: number;
  not_restored: number;
  complete: boolean;
  error?: string;
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

export interface ScheduledJob {
  name: string;
  action: string;
  params: Record<string, unknown>;
  cron: string | null;
  interval_seconds: number | null;
  paused: boolean;
  next_run: string | null;
  persisted: boolean;
}

export interface AddScheduledJobRequest {
  name: string;
  action: string;
  params?: Record<string, unknown>;
  cron?: string;
  interval_seconds?: number;
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

  getRestoreProgress: (requestId: string) =>
    request<{ request_id: string; repos: RestoreProgress[] }>(`/thaw-requests/${requestId}/restore-progress`),

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

  // Scheduler
  getScheduledJobs: () =>
    request<{ jobs: ScheduledJob[] }>('/scheduler/jobs'),

  addScheduledJob: (job: AddScheduledJobRequest) =>
    request<{ name: string; status: string }>('/scheduler/jobs', {
      method: 'POST',
      body: JSON.stringify(job),
    }),

  updateScheduledJob: (name: string, job: AddScheduledJobRequest) =>
    request<{ name: string; status: string }>(`/scheduler/jobs/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify(job),
    }),

  removeScheduledJob: (name: string) =>
    request<{ name: string; status: string }>(`/scheduler/jobs/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }),

  pauseScheduledJob: (name: string) =>
    request<{ name: string; status: string }>(`/scheduler/jobs/${encodeURIComponent(name)}/pause`, {
      method: 'POST',
    }),

  resumeScheduledJob: (name: string) =>
    request<{ name: string; status: string }>(`/scheduler/jobs/${encodeURIComponent(name)}/resume`, {
      method: 'POST',
    }),
};
