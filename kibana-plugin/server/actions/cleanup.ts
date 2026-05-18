/**
 * Cleanup action — drop stale thaw-request documents based on retention
 * windows, and mark/unmount expired repositories.
 *
 * Mirrors the read-only pieces of `Cleanup.do_action` in
 *   packages/deepfreeze-core/deepfreeze_core/actions/cleanup.py
 * Two deliberate omissions for the Phase 3 MVP:
 *
 *   1. **No orphaned ILM policy detection — PENDING.** Rotate now creates
 *      versioned policies (`<base>-<suffix>`) on every rotation, so
 *      orphaned versioned policies accumulate over time once their
 *      bound indices are deleted. The reaper that compares against
 *      `in_use_by.{indices, data_streams, composable_templates}` and
 *      deletes safe-to-remove policies is scheduled for a follow-up
 *      commit alongside Phase 5 (Scheduler). Until then, periodically
 *      delete orphaned `<ilm_policy_name>-*` policies manually via the
 *      Kibana ILM UI if they build up.
 *   2. **No S3 lifecycle integration.** Expired repos are detected
 *      purely from the stored `expires_at` field on the RepositoryDoc
 *      (populated by Thaw in Phase 4). We don't ask the storage SDK
 *      whether a restore is actually still available.
 */

import type { ServiceError } from '../../common/types/errors';
import type { RepositoryDoc } from '../../common/schemas/repository';
import type { SettingsDoc } from '../../common/schemas/settings';
import type { ThawRequestDoc } from '../../common/schemas/thaw_request';
import { MissingIndexError, MissingSettingsError } from '../errors';
import {
  getSettings,
  type SettingsRepoEsClient,
} from '../repositories/settings_repo';
import {
  getAllRepos,
  saveRepositoryDoc,
  type RepositoryRepoWriteEsClient,
} from '../repositories/repository_repo';
import {
  deleteSnapshotRepository,
  type SnapshotRepoEsClient,
} from '../repositories/snapshot_repo';
import {
  deleteThawRequest,
  listThawRequests,
  type ThawRequestRepoWriteEsClient,
} from '../repositories/thaw_request_repo';

export type CleanupActionEsClient = SettingsRepoEsClient &
  RepositoryRepoWriteEsClient &
  ThawRequestRepoWriteEsClient &
  SnapshotRepoEsClient;

export interface CleanupConfig {
  /** Override settings' completed-thaw retention window (days). */
  retention_days_completed?: number;
  /** Override settings' failed-thaw retention window. */
  retention_days_failed?: number;
  /** Override settings' refrozen-thaw retention window. */
  retention_days_refrozen?: number;
}

export interface RunCleanupOptions {
  log?: { debug: (m: string) => void; warn: (m: string) => void };
  /** Inject "now" for deterministic tests. Defaults to Date.now(). */
  now?: () => Date;
}

const NOOP_LOG = { debug: () => {}, warn: () => {} };

export interface CleanupStepRecord {
  type: 'thaw_request' | 'expired_repo';
  action: 'would_delete' | 'would_archive' | 'deleted' | 'archived' | 'skipped';
  name?: string;
  detail?: string;
}

export interface CleanupResult {
  success: boolean;
  dry_run: boolean;
  /** Thaw request IDs that were (or would be) deleted. */
  deleted_thaw_requests: string[];
  /** Repository names that were (or would be) flipped to frozen. */
  expired_repositories: string[];
  steps: CleanupStepRecord[];
  errors: ServiceError[];
  started_at: string;
  completed_at: string;
}

/**
 * Effective retention windows after applying any one-off overrides.
 * Exposed as a helper so the dry-run and real-run paths report
 * identical numbers.
 */
function effectiveRetention(
  settings: SettingsDoc,
  config: CleanupConfig
): {
  completed: number;
  failed: number;
  refrozen: number;
} {
  return {
    completed:
      config.retention_days_completed ?? settings.thaw_request_retention_days_completed,
    failed:
      config.retention_days_failed ?? settings.thaw_request_retention_days_failed,
    refrozen:
      config.retention_days_refrozen ?? settings.thaw_request_retention_days_refrozen,
  };
}

interface ExpiredThaw {
  request: ThawRequestDoc;
  age_days: number;
  retention_days: number;
}

/**
 * Identify thaw requests past their retention window. `now` is injected
 * so tests are deterministic; defaults to the current time.
 */
function findExpiredThawRequests(
  requests: ThawRequestDoc[],
  retention: { completed: number; failed: number; refrozen: number },
  now: Date
): ExpiredThaw[] {
  const expired: ExpiredThaw[] = [];
  for (const req of requests) {
    if (!req.created_at) continue;
    const created = Date.parse(req.created_at);
    if (Number.isNaN(created)) continue;

    const age_days = Math.floor((now.getTime() - created) / (1000 * 60 * 60 * 24));
    let cap: number | null = null;
    if (req.status === 'completed') cap = retention.completed;
    else if (req.status === 'failed') cap = retention.failed;
    else if (req.status === 'refrozen') cap = retention.refrozen;
    if (cap === null) continue;

    if (age_days > cap) {
      expired.push({ request: req, age_days, retention_days: cap });
    }
  }
  return expired;
}

/**
 * Identify repositories that are past their S3 restore window — either
 * already marked `expired`, or `expires_at` is in the past. Includes
 * `thawed` repos so they get reset back to `frozen` once their
 * restore expires.
 */
function findExpiredRepos(repos: RepositoryDoc[], now: Date): RepositoryDoc[] {
  return repos.filter((r) => {
    if (r.thaw_state === 'expired') return true;
    if (!r.expires_at) return false;
    const expiresMs = Date.parse(r.expires_at);
    if (Number.isNaN(expiresMs)) return false;
    return expiresMs < now.getTime();
  });
}

/**
 * Load settings or throw. Same uninitialized-state contract as Rotate.
 */
async function loadInitializedSettings(client: CleanupActionEsClient): Promise<SettingsDoc> {
  const settings = await getSettings(client);
  if (!settings) {
    throw new MissingSettingsError('Settings document not found in status index');
  }
  return settings;
}

/**
 * Compute the would-be CleanupResult without touching the cluster.
 *
 * Throws `MissingIndexError` / `MissingSettingsError` for uninitialized
 * clusters; never throws on a successful dry-run.
 */
export async function runCleanupDryRun(
  client: CleanupActionEsClient,
  config: CleanupConfig = {},
  options: RunCleanupOptions = {}
): Promise<CleanupResult> {
  const started_at = new Date().toISOString();
  const now = (options.now ?? (() => new Date()))();

  const settings = await loadInitializedSettings(client);
  const retention = effectiveRetention(settings, config);

  const [requests, repos] = await Promise.all([
    listThawRequests(client),
    getAllRepos(client),
  ]);

  const expiredThaws = findExpiredThawRequests(requests, retention, now);
  const expiredRepos = findExpiredRepos(repos, now);

  const steps: CleanupStepRecord[] = [
    ...expiredThaws.map<CleanupStepRecord>((e) => ({
      type: 'thaw_request',
      action: 'would_delete',
      name: e.request.request_id,
      detail: `age ${e.age_days}d > retention ${e.retention_days}d (${e.request.status})`,
    })),
    ...expiredRepos.map<CleanupStepRecord>((r) => ({
      type: 'expired_repo',
      action: 'would_archive',
      name: r.name,
    })),
  ];

  return {
    success: true,
    dry_run: true,
    deleted_thaw_requests: expiredThaws.map((e) => e.request.request_id),
    expired_repositories: expiredRepos.map((r) => r.name),
    steps,
    errors: [],
    started_at,
    completed_at: new Date().toISOString(),
  };
}

/**
 * Execute the cleanup. Per-document failures degrade to warnings in
 * `errors[]` and continue; the operation only aborts on the
 * uninitialized-cluster preconditions.
 */
export async function runCleanup(
  client: CleanupActionEsClient,
  config: CleanupConfig = {},
  options: RunCleanupOptions = {}
): Promise<CleanupResult> {
  const log = options.log ?? NOOP_LOG;
  const started_at = new Date().toISOString();
  const now = (options.now ?? (() => new Date()))();

  const settings = await loadInitializedSettings(client);
  const retention = effectiveRetention(settings, config);

  const [requests, repos] = await Promise.all([
    listThawRequests(client),
    getAllRepos(client),
  ]);

  const expiredThaws = findExpiredThawRequests(requests, retention, now);
  const expiredRepos = findExpiredRepos(repos, now);

  const steps: CleanupStepRecord[] = [];
  const errors: ServiceError[] = [];
  const deleted: string[] = [];
  const archived: string[] = [];

  for (const { request, age_days, retention_days } of expiredThaws) {
    try {
      await deleteThawRequest(client, request.request_id);
      deleted.push(request.request_id);
      steps.push({
        type: 'thaw_request',
        action: 'deleted',
        name: request.request_id,
        detail: `age ${age_days}d > retention ${retention_days}d (${request.status})`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Failed to delete thaw request ${request.request_id}: ${msg}`);
      errors.push({
        code: 'ACTION_FAILED',
        message: `Failed to delete thaw request ${request.request_id}: ${msg}`,
        severity: 'warning',
        target: request.request_id,
      });
      steps.push({
        type: 'thaw_request',
        action: 'skipped',
        name: request.request_id,
      });
    }
  }

  for (const repo of expiredRepos) {
    try {
      // The repo may already be unmounted. deleteSnapshotRepository is
      // idempotent on 404, so we just call it.
      await deleteSnapshotRepository(client, repo.name);
      await saveRepositoryDoc(client, {
        ...repo,
        is_mounted: false,
        is_thawed: false,
        thaw_state: 'frozen',
        thawed_at: null,
        expires_at: null,
      });
      archived.push(repo.name);
      steps.push({ type: 'expired_repo', action: 'archived', name: repo.name });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Failed to archive expired repo ${repo.name}: ${msg}`);
      errors.push({
        code: 'ACTION_FAILED',
        message: `Failed to archive expired repo ${repo.name}: ${msg}`,
        severity: 'warning',
        target: repo.name,
      });
      steps.push({ type: 'expired_repo', action: 'skipped', name: repo.name });
    }
  }

  return {
    success: true,
    dry_run: false,
    deleted_thaw_requests: deleted,
    expired_repositories: archived,
    steps,
    errors,
    started_at,
    completed_at: new Date().toISOString(),
  };
}

// Re-export for callers that want them.
export {
  MissingIndexError,
  MissingSettingsError,
};
