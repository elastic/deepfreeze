import type { ThawRequestStatus } from '../constants';

/**
 * Thaw request document stored in the `deepfreeze-status` index.
 *
 * The document ID is the `request_id` (UUID).
 *
 * Wire format (snake_case). Source-of-truth in Python:
 *   packages/deepfreeze-core/deepfreeze_core/utilities.py — save_thaw_request()
 *
 * `start_date` / `end_date` are optional and represent the user-facing
 * date range of indices being thawed; `created_at` is when the request
 * was filed. All dates are ISO 8601 strings.
 */
export interface ThawRequestDoc {
  doctype: 'thaw_request';
  request_id: string;
  repos: string[];
  status: ThawRequestStatus;
  created_at: string;
  start_date?: string;
  end_date?: string;
}
