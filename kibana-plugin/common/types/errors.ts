/**
 * Structured error type returned by API routes when an action fails.
 *
 * Mirrors `ServiceError` in
 *   packages/deepfreeze-server/deepfreeze_server/models/errors.py
 *
 * `code` values come from a fixed catalogue mapped from
 * `deepfreeze_core.exceptions` — see `ERROR_CODES` below.
 */
export interface ServiceError {
  code: ServiceErrorCode;
  message: string;
  target?: string | null;
  remediation?: string | null;
  severity: 'error' | 'warning';
}

export const ERROR_CODES = [
  'MISSING_INDEX',
  'MISSING_SETTINGS',
  'PRECONDITION_FAILED',
  'REPOSITORY_ERROR',
  'ACTION_FAILED',
  'DEEPFREEZE_ERROR',
  'INTERNAL_ERROR',
] as const;
export type ServiceErrorCode = (typeof ERROR_CODES)[number];
