/**
 * Action request/response shapes — the HTTP contract for /api/deepfreeze/actions/*.
 *
 * Mirrors:
 *   packages/deepfreeze-server/deepfreeze_server/models/commands.py
 *
 * Dates are ISO 8601 strings on the wire. Optional fields use `?` rather
 * than `| null` when the Python model has a default value the server
 * supplies; nullable-but-present fields keep `| null` to match Pydantic
 * `X | None` semantics.
 */

export interface CommandResult {
  success: boolean;
  action: string;
  dry_run: boolean;
  summary: string;
  details: Array<Record<string, unknown>>;
  errors: unknown[];
  raw_output: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number;
}

// -- Action request models --

export interface RotateRequest {
  year?: number | null;
  month?: number | null;
  keep?: number;
  dry_run?: boolean;
}

export interface ThawCreateRequest {
  start_date: string; // ISO 8601
  end_date: string; // ISO 8601
  duration?: number;
  tier?: ThawTier;
  sync?: boolean;
  dry_run?: boolean;
}

export const THAW_TIERS = ['Standard', 'Expedited', 'Bulk'] as const;
export type ThawTier = (typeof THAW_TIERS)[number];

export interface ThawCheckRequest {
  request_id?: string | null;
}

export interface RefreezeRequest {
  request_id?: string | null;
  dry_run?: boolean;
}

export interface CleanupRequest {
  refrozen_retention_days?: number | null;
  dry_run?: boolean;
}

export interface RepairRequest {
  dry_run?: boolean;
}

export interface SetupRequest {
  repo_name_prefix?: string;
  bucket_name_prefix?: string;
  ilm_policy_name?: string | null;
  index_template_name?: string | null;
  dry_run?: boolean;
}
