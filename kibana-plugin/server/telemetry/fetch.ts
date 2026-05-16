import { runStatus, type StatusActionEsClient } from '../actions/status';
import type { DeepfreezeUsageData } from './types';

const EMPTY: DeepfreezeUsageData = {
  initialized: false,
  provider: 'unknown',
  rotate_by: 'unknown',
  style: 'unknown',
  repositories_total: 0,
  repositories_active: 0,
  repositories_frozen: 0,
  repositories_thawing: 0,
  repositories_thawed: 0,
  repositories_expired: 0,
  repositories_mounted: 0,
  thaw_requests_total: 0,
  thaw_requests_in_progress: 0,
  thaw_requests_completed: 0,
  thaw_requests_failed: 0,
  thaw_requests_refrozen: 0,
};

/**
 * Build the deepfreeze usage report. Mirrors the `/api/deepfreeze/status`
 * payload but only emits bounded scalar fields — never PII such as
 * bucket names or prefixes.
 *
 * If `runStatus` reports `initialized: false`, the returned record is
 * the empty/zeroed shape with `initialized: false`. Errors from
 * `runStatus` are propagated; the caller (the usage collector) wraps
 * the fetch in its own try/catch.
 */
export async function fetchDeepfreezeUsage(
  client: StatusActionEsClient
): Promise<DeepfreezeUsageData> {
  const status = await runStatus(client);

  if (!status.initialized || !status.settings) {
    return EMPTY;
  }

  const repos = status.repositories;
  const thaws = status.thaw_requests;

  return {
    initialized: true,
    provider: status.settings.provider,
    rotate_by: status.settings.rotate_by,
    style: status.settings.style,

    repositories_total: repos.length,
    repositories_active: repos.filter((r) => r.thaw_state === 'active').length,
    repositories_frozen: repos.filter((r) => r.thaw_state === 'frozen').length,
    repositories_thawing: repos.filter((r) => r.thaw_state === 'thawing').length,
    repositories_thawed: repos.filter((r) => r.thaw_state === 'thawed').length,
    repositories_expired: repos.filter((r) => r.thaw_state === 'expired').length,
    repositories_mounted: repos.filter((r) => r.is_mounted).length,

    thaw_requests_total: thaws.length,
    thaw_requests_in_progress: thaws.filter((t) => t.status === 'in_progress').length,
    thaw_requests_completed: thaws.filter((t) => t.status === 'completed').length,
    thaw_requests_failed: thaws.filter((t) => t.status === 'failed').length,
    thaw_requests_refrozen: thaws.filter((t) => t.status === 'refrozen').length,
  };
}
