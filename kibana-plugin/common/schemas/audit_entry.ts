/**
 * Audit log document stored in the `deepfreeze-audit` index.
 *
 * Wire format (snake_case). Source-of-truth in Python:
 *   packages/deepfreeze-core/deepfreeze_core/audit.py — AuditLogger.log_action()
 *
 * `parameters`, `results`, `errors`, and `summary` are stored with
 * `enabled: false` in the index mapping — they round-trip as arbitrary
 * JSON without being indexed/queried.
 */
export interface AuditEntryDoc {
  timestamp: string;
  action: string;
  dry_run: boolean;
  success: boolean;
  duration_ms: number;
  parameters: Record<string, unknown>;
  results: unknown[];
  errors: unknown[];
  summary: Record<string, unknown>;
  user: string;
  hostname: string;
  version: string;
}
