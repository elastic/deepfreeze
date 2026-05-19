/**
 * Cleanup action — drop stale thaw-request documents based on retention
 * windows, mark/unmount expired repositories, and reap orphaned
 * versioned ILM policies left behind by Rotate.
 *
 * Mirrors the read-only pieces of `Cleanup.do_action` in
 *   packages/deepfreeze-core/deepfreeze_core/actions/cleanup.py
 *
 * One deliberate omission for the Phase 3 MVP:
 *
 *   - **No S3 lifecycle integration.** Expired repos are detected
 *     purely from the stored `expires_at` field on the RepositoryDoc
 *     (populated by Thaw in Phase 4). We don't ask the storage SDK
 *     whether a restore is actually still available.
 *
 * Orphaned ILM policy detection (mirrors `_find_orphaned_policies` +
 * `_cleanup_orphaned_policies` in Python's cleanup.py):
 *   - For each policy in the cluster, walk its phases looking for a
 *     `searchable_snapshot.snapshot_repository` reference.
 *   - If the referenced repo starts with `settings.repo_name_prefix`
 *     AND that repo no longer exists in ES → candidate.
 *   - Final gate: `isPolicySafeToDelete` ensures zero references from
 *     indices, data_streams, and composable_templates before deletion.
 *   - Base policy (`settings.ilm_policy_name` itself, no suffix) is
 *     never touched — only versioned children.
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
import {
  deleteIlmPolicy,
  isPolicySafeToDelete,
  type IlmPolicyEntry,
  type IlmRepoWriteEsClient,
} from '../repositories/ilm_repo';

export type CleanupActionEsClient = SettingsRepoEsClient &
  RepositoryRepoWriteEsClient &
  ThawRequestRepoWriteEsClient &
  SnapshotRepoEsClient &
  IlmRepoWriteEsClient;

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
  type: 'thaw_request' | 'expired_repo' | 'ilm_policy';
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
  /** Versioned ILM policy names that were (or would be) deleted as orphans. */
  deleted_policies: string[];
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
 * Find versioned ILM policies that reference a deepfreeze repository
 * which no longer exists in ES. The base policy (settings.ilm_policy_name
 * without a suffix) is never considered orphaned — it's the stable
 * source-of-truth Setup and Rotate clone from.
 *
 * Mirrors `_find_orphaned_policies` in
 *   packages/deepfreeze-core/deepfreeze_core/actions/cleanup.py
 */
async function findOrphanedPolicies(
  client: CleanupActionEsClient,
  settings: SettingsDoc
): Promise<Array<{ policy_name: string; referenced_repo: string }>> {
  if (!settings.ilm_policy_name) return [];

  const allPolicies = (await client.ilm.getLifecycle()) as Record<
    string,
    IlmPolicyEntry
  >;
  // Live snapshot repos in the cluster — anything not in this set
  // that's referenced by a policy is a candidate orphan.
  const liveRepos = await client.snapshot.getRepository();
  const existing = new Set(Object.keys(liveRepos));

  const orphans: Array<{ policy_name: string; referenced_repo: string }> = [];

  for (const [policyName, policyData] of Object.entries(allPolicies)) {
    // Never touch the base policy itself — it's the immutable source
    // of truth that Setup writes once and Rotate clones from.
    if (policyName === settings.ilm_policy_name) continue;

    const phases = policyData.policy?.phases ?? {};
    for (const phaseConfig of Object.values(phases)) {
      const snapshotRepo = phaseConfig.actions?.searchable_snapshot?.snapshot_repository;
      if (
        snapshotRepo &&
        snapshotRepo.startsWith(`${settings.repo_name_prefix}-`) &&
        !existing.has(snapshotRepo)
      ) {
        orphans.push({ policy_name: policyName, referenced_repo: snapshotRepo });
        break; // one entry per policy
      }
    }
  }

  return orphans;
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
  const orphanCandidates = await findOrphanedPolicies(client, settings);

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
    ...orphanCandidates.map<CleanupStepRecord>((o) => ({
      type: 'ilm_policy',
      action: 'would_delete',
      name: o.policy_name,
      detail: `references ${o.referenced_repo} (no longer exists)`,
    })),
  ];

  return {
    success: true,
    dry_run: true,
    deleted_thaw_requests: expiredThaws.map((e) => e.request.request_id),
    expired_repositories: expiredRepos.map((r) => r.name),
    deleted_policies: orphanCandidates.map((o) => o.policy_name),
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

  // Orphaned versioned-policy reaper. Runs after repo cleanup because
  // archiving an expired repo can newly orphan its versioned policy
  // (the same-run case for clusters where Cleanup is the first thing
  // run after a long absence).
  const deletedPolicies: string[] = [];
  try {
    const candidates = await findOrphanedPolicies(client, settings);
    for (const orphan of candidates) {
      try {
        const safe = await isPolicySafeToDelete(client, orphan.policy_name);
        if (!safe) {
          steps.push({
            type: 'ilm_policy',
            action: 'skipped',
            name: orphan.policy_name,
            detail: 'still in use by indices, data streams, or templates',
          });
          continue;
        }
        await deleteIlmPolicy(client, orphan.policy_name);
        deletedPolicies.push(orphan.policy_name);
        steps.push({
          type: 'ilm_policy',
          action: 'deleted',
          name: orphan.policy_name,
          detail: `was referencing ${orphan.referenced_repo}`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`Failed to reap orphaned policy ${orphan.policy_name}: ${msg}`);
        errors.push({
          code: 'ACTION_FAILED',
          message: `Failed to reap orphaned policy ${orphan.policy_name}: ${msg}`,
          severity: 'warning',
          target: orphan.policy_name,
        });
        steps.push({
          type: 'ilm_policy',
          action: 'skipped',
          name: orphan.policy_name,
          detail: msg,
        });
      }
    }
  } catch (err) {
    // Enumeration itself failed (ES auth, ILM API down, etc.). Log
    // and continue — thaw_request + expired_repo cleanup already
    // happened above and shouldn't be lost.
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Orphaned-policy detection failed: ${msg}`);
    errors.push({
      code: 'ACTION_FAILED',
      message: `Orphaned-policy detection failed: ${msg}`,
      severity: 'warning',
    });
  }

  return {
    success: true,
    dry_run: false,
    deleted_thaw_requests: deleted,
    expired_repositories: archived,
    deleted_policies: deletedPolicies,
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
