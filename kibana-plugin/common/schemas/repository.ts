import type { ThawState } from '../constants';

/**
 * Repository document stored in the `deepfreeze-status` index.
 *
 * Wire format (snake_case). Source-of-truth in Python:
 *   packages/deepfreeze-core/deepfreeze_core/helpers.py — Repository.to_dict()
 *
 * Field semantics:
 *   - `is_thawed` is deprecated; use `thaw_state` for state checks.
 *     It is still written for backward compatibility with older readers.
 *   - `thawed_at` is set when restore completes (thawing → thawed).
 *   - `expires_at` is set when restore is initiated and indicates when
 *     S3 will revert the object to Glacier.
 *   - Dates are ISO 8601 strings on the wire.
 */
export interface RepositoryDoc {
  doctype: 'repository';
  name: string;
  bucket: string;
  base_path: string;
  start: string | null;
  end: string | null;
  is_thawed: boolean;
  is_mounted: boolean;
  thaw_state: ThawState;
  thawed_at: string | null;
  expires_at: string | null;
}
