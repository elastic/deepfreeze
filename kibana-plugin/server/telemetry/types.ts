import type { Provider } from '../../common/constants';

/**
 * Shape of the data the deepfreeze usage collector reports back to
 * Elastic telemetry. Strictly non-identifying:
 *   - counts and booleans only,
 *   - free-form strings from settings (prefixes, bucket names) are
 *     excluded; only bounded categorical settings (provider, rotate_by,
 *     style) leave the cluster.
 */
export interface DeepfreezeUsageData {
  /** True once a settings document exists in the deepfreeze-status index. */
  initialized: boolean;
  /** Provider from settings, or 'unknown' if uninitialized. */
  provider: Provider | 'unknown';
  /** Rotation grouping from settings, or 'unknown' if uninitialized. */
  rotate_by: 'path' | 'bucket' | 'unknown';
  /** Rotation style from settings, or 'unknown' if uninitialized. */
  style: 'oneup' | 'date' | 'unknown';

  repositories_total: number;
  repositories_active: number;
  repositories_frozen: number;
  repositories_thawing: number;
  repositories_thawed: number;
  repositories_expired: number;
  repositories_mounted: number;

  thaw_requests_total: number;
  thaw_requests_in_progress: number;
  thaw_requests_completed: number;
  thaw_requests_failed: number;
  thaw_requests_refrozen: number;
}
