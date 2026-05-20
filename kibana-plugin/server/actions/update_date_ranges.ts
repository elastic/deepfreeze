/**
 * UpdateDateRanges action — walk every mounted repository, query its
 * indices' `@timestamp` min/max, and persist the result back to the
 * RepositoryDoc. Run on a tight cadence (e.g. hourly) so the status
 * index keeps pace with newly-ingested data instead of waiting for
 * the next Rotate.
 *
 * Net-new vs. Python — this is a Kibana-only schedulable. Python's
 * `Rotate._update_date_ranges` does the equivalent inline as part of
 * rotation; here we lift the same `update_repository_date_range`
 * primitive into its own schedulable action so operators can drive
 * the cadence independently of rotate.
 *
 * Differs intentionally from `RepairMetadata._update_date_ranges`:
 *   - RepairMetadata only fills MISSING start/end (one-shot).
 *   - This action extends EXISTING ranges using the helper's
 *     only-extend, never-shrink merge rule. That's the right
 *     behavior for periodic re-runs as new data arrives.
 *
 * S3-free by design: every operation is an ES round-trip (snapshot
 * list + index exists + min/max agg + status-doc index). Safe to
 * schedule on a tight interval without touching storage providers.
 */

import type { ServiceError } from '../../common/types/errors';
import {
  getAllRepos,
  type RepositoryRepoWriteEsClient,
} from '../repositories/repository_repo';
import {
  updateRepositoryDateRange,
  type DateRangeEsClient,
  type DateRangeOutcome,
} from '../repositories/repository_date_range';

export type UpdateDateRangesActionEsClient = RepositoryRepoWriteEsClient &
  DateRangeEsClient;

export interface UpdateDateRangesConfig {
  /**
   * Reserved for future use — e.g. limit to a subset of repos by
   * prefix. The action accepts an arbitrary params bag so a scheduled
   * job's `params` field doesn't have to be empty.
   */
  [key: string]: unknown;
}

export interface UpdateDateRangesStepRecord {
  type: 'repository';
  action: 'updated' | 'unchanged' | 'skipped' | 'failed';
  /** Repo name. */
  name: string;
  /** Brief human-readable detail (e.g. "2026-01-01 → 2026-05-19"). */
  detail?: string;
}

export interface UpdateDateRangesResult {
  success: boolean;
  /** Repos whose start/end was extended on this run. */
  updated: string[];
  /** Mounted but not changed (already up-to-date, no @timestamp, etc.). */
  unchanged: string[];
  /** Unmounted repos and any other deliberate skips, with reason. */
  skipped: Array<{ repo: string; reason: string }>;
  /** Per-repo outcome records straight from the helper. */
  outcomes: DateRangeOutcome[];
  steps: UpdateDateRangesStepRecord[];
  errors: ServiceError[];
  started_at: string;
  completed_at: string;
}

export interface RunUpdateDateRangesOptions {
  log?: { debug: (m: string) => void; warn: (m: string) => void };
}

const NOOP_LOG = { debug: () => {}, warn: () => {} };

export async function runUpdateDateRanges(
  client: UpdateDateRangesActionEsClient,
  _config: UpdateDateRangesConfig = {},
  options: RunUpdateDateRangesOptions = {}
): Promise<UpdateDateRangesResult> {
  const log = options.log ?? NOOP_LOG;
  const started_at = new Date().toISOString();

  const result: UpdateDateRangesResult = {
    success: true,
    updated: [],
    unchanged: [],
    skipped: [],
    outcomes: [],
    steps: [],
    errors: [],
    started_at,
    completed_at: '',
  };

  const repos = await getAllRepos(client);
  log.debug(`update_date_ranges: scanning ${repos.length} repo(s)`);

  for (const repo of repos) {
    // Unmounted repos can't be queried for @timestamp; record and skip.
    if (!repo.is_mounted) {
      result.skipped.push({
        repo: repo.name,
        reason: 'repo not mounted; @timestamp unavailable',
      });
      result.steps.push({
        type: 'repository',
        action: 'skipped',
        name: repo.name,
        detail: 'unmounted',
      });
      continue;
    }

    const outcome = await updateRepositoryDateRange(client, repo);
    result.outcomes.push(outcome);

    if (outcome.error) {
      result.errors.push({
        code: 'ACTION_FAILED',
        message: `Date-range update failed for ${repo.name}: ${outcome.error}`,
        severity: 'warning',
        target: repo.name,
      });
      result.steps.push({
        type: 'repository',
        action: 'failed',
        name: repo.name,
        detail: outcome.error,
      });
      continue;
    }

    if (outcome.changed) {
      result.updated.push(repo.name);
      result.steps.push({
        type: 'repository',
        action: 'updated',
        name: repo.name,
        detail: `${outcome.previous_start ?? '∅'} → ${outcome.start ?? '∅'} .. ${outcome.previous_end ?? '∅'} → ${outcome.end ?? '∅'}`,
      });
    } else {
      result.unchanged.push(repo.name);
      result.steps.push({
        type: 'repository',
        action: 'unchanged',
        name: repo.name,
        detail: outcome.skipped_reason,
      });
    }
  }

  result.completed_at = new Date().toISOString();
  return result;
}
