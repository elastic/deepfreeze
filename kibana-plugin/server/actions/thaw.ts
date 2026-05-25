/**
 * Thaw action — initiate restore-from-Glacier for repositories whose
 * data overlaps the requested date range, then persist a thaw_request
 * doc with status='in_progress' so the UI can poll for progress.
 *
 * Mirrors `Thaw._initiate_thaw` in
 *   packages/deepfreeze-core/deepfreeze_core/actions/thaw.py
 * with the rich-console output and porcelain branches stripped — the
 * UI consumes the structured result and formats its own progress.
 *
 * Polling and the final searchable-snapshot mount happen in Step 3's
 * `/check` route; this action only initiates and persists.
 */

import { randomUUID } from 'node:crypto';

import type { ServiceError } from '../../common/types/errors';
import type { RepositoryDoc } from '../../common/schemas/repository';
import type { ThawRequestDoc } from '../../common/schemas/thaw_request';
import { ActionError, MissingSettingsError } from '../errors';
import {
  getSettings,
  type SettingsRepoEsClient,
} from '../repositories/settings_repo';
import {
  findReposByDateRange,
  getAllRepos,
  saveRepositoryDoc,
  type RepositoryRepoWriteEsClient,
} from '../repositories/repository_repo';
import {
  createSnapshotRepository,
  type SnapshotRepoEsClient,
} from '../repositories/snapshot_repo';
import {
  assignIlmPolicy,
  ensureThawedIlmPolicy,
  findLatestSnapshotForIndex,
  getAllIndicesInRepo,
  mountSnapshotIndex,
  stripFmClonePrefix,
  type SearchableSnapshotEsClient,
} from '../repositories/searchable_snapshot';
import {
  getTimestampRange,
  type DateRangeEsClient,
} from '../repositories/repository_date_range';
import {
  getThawRequest,
  saveThawRequest,
  type ThawRequestRepoWriteEsClient,
} from '../repositories/thaw_request_repo';
import type { RetrievalTier, StorageClient } from '../storage/types';

/**
 * Defaults used when `ThawConfig` doesn't specify them. The Thaw UI
 * defaults to these too so an operator who just hits "Initiate" gets
 * the same conservative pick as before this knob existed.
 *
 * Range constraints (enforced at the route schema, not here):
 *   - restore_days: integer, 1..30 (matches the S3 RestoreObject limit)
 *   - retrieval_tier: 'Standard' | 'Expedited' | 'Bulk'
 */
export const DEFAULT_RESTORE_DAYS = 7;
export const DEFAULT_RETRIEVAL_TIER: RetrievalTier = 'Standard';
export const MIN_RESTORE_DAYS = 1;
export const MAX_RESTORE_DAYS = 30;

/** Restore objects in batches of this size to bound concurrent SDK calls. */
const RESTORE_BATCH = 10;

export type ThawActionEsClient = SettingsRepoEsClient &
  RepositoryRepoWriteEsClient &
  ThawRequestRepoWriteEsClient &
  SnapshotRepoEsClient &
  SearchableSnapshotEsClient &
  DateRangeEsClient;

export interface ThawConfig {
  /** ISO 8601 inclusive start of the date range to thaw. */
  start_date: string;
  /** ISO 8601 inclusive end of the date range to thaw. */
  end_date: string;
  /**
   * S3 restore-window length in days. Drives both the `Days` field of
   * the `s3:RestoreObject` request AND the persisted `expires_at` on
   * each affected RepositoryDoc — they must agree or the operator gets
   * a misleading deadline. Defaults to `DEFAULT_RESTORE_DAYS`.
   */
  restore_days?: number;
  /**
   * Glacier retrieval tier. Tradeoff is latency vs cost:
   *   - 'Expedited': 1–5 min, $$$
   *   - 'Standard':  3–5 hr, $
   *   - 'Bulk':      5–12 hr, $ (cheapest)
   * Defaults to `DEFAULT_RETRIEVAL_TIER`.
   */
  retrieval_tier?: RetrievalTier;
}

export interface RunThawOptions {
  log?: { debug: (m: string) => void; warn: (m: string) => void };
  /** Test seam: override request_id generation. */
  generateRequestId?: () => string;
  /** Test seam: override "now" for deterministic expires_at. */
  now?: () => Date;
}

const NOOP_LOG = { debug: () => {}, warn: () => {} };

export interface ThawStepRecord {
  type: 'thaw_request' | 'repository' | 'object';
  action:
    | 'created'
    | 'would_thaw'
    | 'restore_initiated'
    | 'skipped'
    | 'thawing'
    | 'failed';
  name?: string;
  detail?: string;
}

export interface ThawResult {
  success: boolean;
  dry_run: boolean;
  /** UUID-prefix used as the thaw request ID, or null when no repos matched. */
  request_id: string | null;
  /** Repo names included in the request (in stable order). */
  repos: string[];
  steps: ThawStepRecord[];
  errors: ServiceError[];
  /** Per-repo object counts for the operator: total / restore_initiated / skipped. */
  repo_object_stats: Array<{
    repo: string;
    total: number;
    restore_initiated: number;
    already_accessible: number;
    failed: number;
  }>;
  started_at: string;
  completed_at: string;
}

async function loadInitializedSettings(
  client: ThawActionEsClient
): Promise<void> {
  const settings = await getSettings(client);
  if (!settings) {
    throw new MissingSettingsError('Settings document not found in status index');
  }
}

function defaultRequestId(): string {
  // Python uses `str(uuid.uuid4())[:8]`; mirror that 8-char prefix.
  return randomUUID().replace(/-/g, '').slice(0, 8);
}

/**
 * Preview the thaw: resolve which repos overlap the range and report
 * what would happen, but issue no S3 calls and persist nothing.
 */
export async function runThawDryRun(
  client: ThawActionEsClient,
  config: ThawConfig
): Promise<ThawResult> {
  const started_at = new Date().toISOString();
  await loadInitializedSettings(client);

  const repos = await findReposByDateRange(client, config.start_date, config.end_date);
  const steps: ThawStepRecord[] = [];

  for (const repo of repos) {
    steps.push({
      type: 'repository',
      action: 'would_thaw',
      name: repo.name,
      detail: `${repo.bucket}/${repo.base_path}`,
    });
  }

  return {
    success: true,
    dry_run: true,
    request_id: null,
    repos: repos.map((r) => r.name),
    steps,
    errors: [],
    repo_object_stats: [],
    started_at,
    completed_at: new Date().toISOString(),
  };
}

interface RepoRestoreOutcome {
  total: number;
  restore_initiated: number;
  already_accessible: number;
  failed: number;
  errors: ServiceError[];
}

/**
 * For one repo: list every object under `bucket/base_path`, head each
 * one, and issue restore for the non-accessible objects. Per-object
 * failures degrade to warnings and accumulate into `outcome.errors`.
 *
 * Concurrency is bounded by RESTORE_BATCH chunks of Promise.allSettled
 * so we never hammer the AWS SDK with thousands of inflight requests
 * for one large repo.
 */
async function restoreOneRepo(
  storage: StorageClient,
  repo: RepositoryDoc,
  steps: ThawStepRecord[],
  log: { debug: (m: string) => void; warn: (m: string) => void },
  restoreDays: number,
  retrievalTier: RetrievalTier
): Promise<RepoRestoreOutcome> {
  const outcome: RepoRestoreOutcome = {
    total: 0,
    restore_initiated: 0,
    already_accessible: 0,
    failed: 0,
    errors: [],
  };

  const objects = await storage.listObjects(repo.bucket, repo.base_path);
  outcome.total = objects.length;
  log.debug(
    `Thaw ${repo.name}: ${objects.length} object(s) under ${repo.bucket}/${repo.base_path}`
  );

  for (let i = 0; i < objects.length; i += RESTORE_BATCH) {
    const batch = objects.slice(i, i + RESTORE_BATCH);
    const results = await Promise.allSettled(
      batch.map(async (obj) => {
        const state = await storage.headObject(repo.bucket, obj.key);
        if (state.accessible) return { key: obj.key, restored: false as const };
        if (state.restore && state.restore.ongoing) {
          return { key: obj.key, restored: false as const };
        }
        await storage.restoreObject(repo.bucket, obj.key, {
          days: restoreDays,
          tier: retrievalTier,
        });
        return { key: obj.key, restored: true as const };
      })
    );

    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      const key = batch[j].key;
      if (r.status === 'fulfilled') {
        if (r.value.restored) {
          outcome.restore_initiated += 1;
        } else {
          outcome.already_accessible += 1;
        }
      } else {
        outcome.failed += 1;
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        log.warn(`Restore failed for ${repo.bucket}/${key}: ${msg}`);
        outcome.errors.push({
          code: 'ACTION_FAILED',
          message: `Restore failed for ${key}: ${msg}`,
          severity: 'warning',
          target: `${repo.bucket}/${key}`,
        });
        steps.push({
          type: 'object',
          action: 'failed',
          name: key,
          detail: msg,
        });
      }
    }
  }

  return outcome;
}

/**
 * Initiate a thaw operation:
 *   1. Verify settings exist (else `MissingSettingsError`).
 *   2. Find repos overlapping the date range.
 *   3. Save the ThawRequestDoc as in_progress BEFORE issuing restores
 *      so the request survives mid-flight crashes.
 *   4. For each repo: list + head + restore each non-accessible object.
 *   5. Flip the RepositoryDoc thaw_state to 'thawing' (per repo).
 *
 * Per-repo failures don't abort the operation: every repo gets a step
 * record, the request stays in_progress, and the user can re-run or
 * poll via the /check route.
 */
export async function runThaw(
  client: ThawActionEsClient,
  storage: StorageClient,
  config: ThawConfig,
  options: RunThawOptions = {}
): Promise<ThawResult> {
  const log = options.log ?? NOOP_LOG;
  const now = options.now ?? (() => new Date());
  const started_at = new Date().toISOString();

  await loadInitializedSettings(client);

  const repos = await findReposByDateRange(client, config.start_date, config.end_date);
  const steps: ThawStepRecord[] = [];
  const errors: ServiceError[] = [];
  const repoObjectStats: ThawResult['repo_object_stats'] = [];

  if (repos.length === 0) {
    return {
      success: true,
      dry_run: false,
      request_id: null,
      repos: [],
      steps,
      errors,
      repo_object_stats: [],
      started_at,
      completed_at: new Date().toISOString(),
    };
  }

  const request_id = (options.generateRequestId ?? defaultRequestId)();
  const restoreDays = config.restore_days ?? DEFAULT_RESTORE_DAYS;
  const retrievalTier = config.retrieval_tier ?? DEFAULT_RETRIEVAL_TIER;
  const expiresAt = new Date(
    now().getTime() + restoreDays * 24 * 60 * 60 * 1000
  ).toISOString();

  const requestDoc: ThawRequestDoc = {
    doctype: 'thaw_request',
    request_id,
    repos: repos.map((r) => r.name),
    status: 'in_progress',
    created_at: started_at,
    start_date: config.start_date,
    end_date: config.end_date,
  };
  await saveThawRequest(client, requestDoc);
  steps.push({
    type: 'thaw_request',
    action: 'created',
    name: request_id,
    detail: `${repos.length} repo(s)`,
  });

  for (const repo of repos) {
    log.debug(`Initiating thaw for ${repo.name}`);
    try {
      const outcome = await restoreOneRepo(
        storage,
        repo,
        steps,
        log,
        restoreDays,
        retrievalTier
      );
      repoObjectStats.push({
        repo: repo.name,
        total: outcome.total,
        restore_initiated: outcome.restore_initiated,
        already_accessible: outcome.already_accessible,
        failed: outcome.failed,
      });
      errors.push(...outcome.errors);

      if (outcome.total === 0) {
        steps.push({
          type: 'repository',
          action: 'skipped',
          name: repo.name,
          detail: 'no objects under bucket/base_path',
        });
        continue;
      }

      steps.push({
        type: 'repository',
        action: 'restore_initiated',
        name: repo.name,
        detail: `${outcome.restore_initiated} restore(s) initiated; ${outcome.already_accessible} already accessible; ${outcome.failed} failed`,
      });

      await saveRepositoryDoc(client, {
        ...repo,
        thaw_state: 'thawing',
        is_thawed: false,
        is_mounted: false,
        expires_at: expiresAt,
      });
      steps.push({
        type: 'repository',
        action: 'thawing',
        name: repo.name,
        detail: `expires_at=${expiresAt}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Thaw failed for ${repo.name}: ${msg}`);
      errors.push({
        code: 'ACTION_FAILED',
        message: `Thaw failed for ${repo.name}: ${msg}`,
        severity: 'warning',
        target: repo.name,
      });
      steps.push({
        type: 'repository',
        action: 'failed',
        name: repo.name,
        detail: msg,
      });
    }
  }

  return {
    success: true,
    dry_run: false,
    request_id,
    repos: repos.map((r) => r.name),
    steps,
    errors,
    repo_object_stats: repoObjectStats,
    started_at,
    completed_at: new Date().toISOString(),
  };
}

/**
 * Per-repo restore progress as returned by `inspectThawProgress` and
 * `checkAndMaybeMount`. Counts mirror `check_restore_status` in
 *   packages/deepfreeze-core/deepfreeze_core/utilities.py
 *   - total: all objects under bucket/base_path
 *   - restored: in a hot/accessible tier (no restore needed, or restored)
 *   - in_progress: archive-tier with an active restore (ongoing-request="true")
 *   - not_restored: archive-tier with no restore on file
 */
export interface RepoRestoreProgress {
  repo: string;
  bucket: string;
  base_path: string;
  total: number;
  restored: number;
  in_progress: number;
  not_restored: number;
  complete: boolean;
}

export interface ThawProgressResult {
  request_id: string;
  /**
   * Status at the time of the call. `checkAndMaybeMount` may flip this
   * from `in_progress` to `completed` (or `failed`) before returning.
   */
  status: ThawRequestDoc['status'];
  start_date?: string;
  end_date?: string;
  repos: RepoRestoreProgress[];
  /** True iff every repo has every object accessible. */
  all_complete: boolean;
  /** Set by `checkAndMaybeMount` when it just transitioned to completed. */
  mounted?: boolean;
  /**
   * Count of searchable_snapshot indices the mount step actually
   * brought online for this thaw. Only present on the "just completed"
   * response — undefined while still in_progress or for an already-
   * completed request rechecked later.
   */
  indices_mounted?: number;
  /** Count of indices the mount step pruned because their @timestamp range fell outside the request window. */
  indices_skipped?: number;
  /** Count of indices the mount step couldn't mount (per-index ES errors). */
  indices_failed?: number;
  errors: ServiceError[];
  checked_at: string;
}

async function computeRepoProgress(
  storage: StorageClient,
  repo: RepositoryDoc
): Promise<RepoRestoreProgress> {
  const objects = await storage.listObjects(repo.bucket, repo.base_path);
  const total = objects.length;

  if (total === 0) {
    // Mirrors Python: no objects → not complete (avoids accidentally
    // marking an empty/missing prefix as "all restored").
    return {
      repo: repo.name,
      bucket: repo.bucket,
      base_path: repo.base_path,
      total: 0,
      restored: 0,
      in_progress: 0,
      not_restored: 0,
      complete: false,
    };
  }

  let restored = 0;
  let in_progress = 0;
  let not_restored = 0;

  for (let i = 0; i < objects.length; i += RESTORE_BATCH) {
    const batch = objects.slice(i, i + RESTORE_BATCH);
    const states = await Promise.all(
      batch.map((obj) => storage.headObject(repo.bucket, obj.key))
    );
    for (const state of states) {
      if (state.accessible) restored += 1;
      else if (state.restore && state.restore.ongoing) in_progress += 1;
      else not_restored += 1;
    }
  }

  return {
    repo: repo.name,
    bucket: repo.bucket,
    base_path: repo.base_path,
    total,
    restored,
    in_progress,
    not_restored,
    complete: restored === total,
  };
}

async function loadRequestAndRepos(
  client: ThawActionEsClient,
  request_id: string
): Promise<{ request: ThawRequestDoc; repos: RepositoryDoc[] }> {
  const request = await getThawRequest(client, request_id);
  if (!request) {
    throw new ActionError(`Thaw request ${request_id} not found`);
  }
  const all = await getAllRepos(client);
  const byName = new Map(all.map((r) => [r.name, r]));
  const repos: RepositoryDoc[] = [];
  for (const name of request.repos) {
    const doc = byName.get(name);
    if (doc) repos.push(doc);
  }
  return { request, repos };
}

/**
 * Read-only inspection of a thaw request's restore progress.
 *
 * Returns the current per-repo object counts without mounting or
 * touching the request status. Use this for periodic UI polling that
 * doesn't try to advance the workflow — `checkAndMaybeMount` is the
 * side-effecting version.
 *
 * If the request's status is already terminal (`completed`, `failed`,
 * `refrozen`), we short-circuit and skip the S3 head loop since
 * progress no longer changes.
 */
export async function inspectThawProgress(
  client: ThawActionEsClient,
  storage: StorageClient,
  request_id: string
): Promise<ThawProgressResult> {
  await loadInitializedSettings(client);
  const { request, repos } = await loadRequestAndRepos(client, request_id);
  const checked_at = new Date().toISOString();

  if (request.status !== 'in_progress') {
    return {
      request_id,
      status: request.status,
      start_date: request.start_date,
      end_date: request.end_date,
      repos: [],
      all_complete: request.status === 'completed' || request.status === 'refrozen',
      errors: [],
      checked_at,
    };
  }

  const progress: RepoRestoreProgress[] = [];
  const errors: ServiceError[] = [];
  for (const repo of repos) {
    try {
      progress.push(await computeRepoProgress(storage, repo));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({
        code: 'ACTION_FAILED',
        message: `Progress check failed for ${repo.name}: ${msg}`,
        severity: 'warning',
        target: repo.name,
      });
      progress.push({
        repo: repo.name,
        bucket: repo.bucket,
        base_path: repo.base_path,
        total: 0,
        restored: 0,
        in_progress: 0,
        not_restored: 0,
        complete: false,
      });
    }
  }

  const all_complete = progress.length > 0 && progress.every((p) => p.complete);
  return {
    request_id,
    status: request.status,
    start_date: request.start_date,
    end_date: request.end_date,
    repos: progress,
    all_complete,
    errors,
    checked_at,
  };
}

/**
 * Inspect progress AND, when every repo's restore is complete and the
 * request is still `in_progress`, mount the snapshot repositories and
 * flip the request status to `completed`. If any mount fails, the
 * request is moved to `failed` so the UI can surface the error.
 *
 * Mounting here means re-registering the snapshot repository in ES
 * (`PUT _snapshot/{name}`) so Kibana / kibana users can re-discover
 * the snapshots. Searchable-snapshot index mounting (the `_mount`
 * step in Python's `find_and_mount_indices_in_date_range`) is left to
 * the user / operator for now — this MVP only ensures the repository
 * is reachable.
 */
export async function checkAndMaybeMount(
  client: ThawActionEsClient,
  storage: StorageClient,
  request_id: string,
  options: RunThawOptions = {}
): Promise<ThawProgressResult> {
  const log = options.log ?? NOOP_LOG;
  const now = options.now ?? (() => new Date());

  const settings = await getSettings(client);
  if (!settings) {
    throw new MissingSettingsError('Settings document not found in status index');
  }

  const { request, repos } = await loadRequestAndRepos(client, request_id);
  const checked_at = new Date().toISOString();

  if (request.status !== 'in_progress') {
    return {
      request_id,
      status: request.status,
      start_date: request.start_date,
      end_date: request.end_date,
      repos: [],
      all_complete: request.status === 'completed' || request.status === 'refrozen',
      errors: [],
      checked_at,
    };
  }

  const progress: RepoRestoreProgress[] = [];
  const errors: ServiceError[] = [];
  for (const repo of repos) {
    try {
      progress.push(await computeRepoProgress(storage, repo));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({
        code: 'ACTION_FAILED',
        message: `Progress check failed for ${repo.name}: ${msg}`,
        severity: 'warning',
        target: repo.name,
      });
      progress.push({
        repo: repo.name,
        bucket: repo.bucket,
        base_path: repo.base_path,
        total: 0,
        restored: 0,
        in_progress: 0,
        not_restored: 0,
        complete: false,
      });
    }
  }

  const all_complete = progress.length > 0 && progress.every((p) => p.complete);

  if (!all_complete) {
    return {
      request_id,
      status: 'in_progress',
      start_date: request.start_date,
      end_date: request.end_date,
      repos: progress,
      all_complete: false,
      errors,
      checked_at,
    };
  }

  // All restores complete: mount each repo and flip statuses.
  log.debug(`All restores complete for ${request_id}; mounting ${repos.length} repo(s)`);
  let mountFailed = false;
  const mountedRepos: RepositoryDoc[] = [];
  for (const repo of repos) {
    try {
      await createSnapshotRepository(client, {
        name: repo.name,
        provider: settings.provider,
        bucket: repo.bucket,
        base_path: repo.base_path,
        canned_acl: settings.canned_acl,
        storage_class: settings.storage_class,
      });
      await saveRepositoryDoc(client, {
        ...repo,
        thaw_state: 'thawed',
        is_thawed: true,
        is_mounted: true,
        thawed_at: now().toISOString(),
      });
      mountedRepos.push(repo);
    } catch (err) {
      mountFailed = true;
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Mount failed for ${repo.name}: ${msg}`);
      errors.push({
        code: 'ACTION_FAILED',
        message: `Mount failed for ${repo.name}: ${msg}`,
        severity: 'error',
        target: repo.name,
      });
    }
  }

  // Now that the repos are re-registered with ES, mount the underlying
  // snapshot indices as searchable snapshots. Without this step the
  // operator can see the repo in Stack Management → Snapshot and
  // Restore but the actual data isn't queryable.
  //
  // Best-effort: per-index failures are folded into `errors[]` and the
  // request still completes. A complete mount-step failure only flips
  // the request to `failed` when the repo-level mount above also fails.
  const indexMount = await findAndMountIndicesInDateRange(
    client,
    mountedRepos,
    request.start_date,
    request.end_date,
    log
  );
  for (const e of indexMount.errors) {
    errors.push(e);
  }

  const finalStatus: ThawRequestDoc['status'] = mountFailed ? 'failed' : 'completed';
  await saveThawRequest(client, { ...request, status: finalStatus });

  log.debug(
    `Thaw ${request_id} index-mount summary: ` +
      `${indexMount.mounted} mounted, ` +
      `${indexMount.skipped} skipped (date range), ` +
      `${indexMount.failed} failed`
  );

  return {
    request_id,
    status: finalStatus,
    start_date: request.start_date,
    end_date: request.end_date,
    repos: progress,
    all_complete: true,
    mounted: !mountFailed,
    indices_mounted: indexMount.mounted,
    indices_skipped: indexMount.skipped,
    indices_failed: indexMount.failed,
    errors,
    checked_at,
  };
}

/**
 * For each newly-thawed repo: create the `{repo}-thawed` ILM policy,
 * enumerate every index in the repo's snapshots, mount each as a
 * searchable_snapshot, and trim back any whose `@timestamp` range
 * doesn't overlap the requested `[start_date, end_date]` window. The
 * trim step matches Python `find_and_mount_indices_in_date_range` —
 * we want the operator to get the indices they asked for, not every
 * index that happens to live in the same repo.
 *
 * When `start_date` / `end_date` are absent (legacy thaw_request with
 * no range, or a request whose repos lacked date ranges at the time),
 * we mount everything and skip the trim. Matches Python's fallback.
 *
 * Per-index errors are best-effort — they fold into `errors[]` and the
 * loop continues. A catastrophic per-repo error (e.g. `snapshot.get`
 * fails) records one error and moves to the next repo.
 */
async function findAndMountIndicesInDateRange(
  client: ThawActionEsClient,
  repos: RepositoryDoc[],
  startDate: string | undefined,
  endDate: string | undefined,
  log: { debug: (m: string) => void; warn: (m: string) => void }
): Promise<{
  mounted: number;
  skipped: number;
  failed: number;
  errors: ServiceError[];
}> {
  const errors: ServiceError[] = [];
  let mounted = 0;
  let skipped = 0;
  let failed = 0;

  // Decide whether to do the date-overlap trim. Both bounds must be
  // present and parse as valid timestamps; otherwise we mount-and-keep.
  const start = startDate ? Date.parse(startDate) : NaN;
  const end = endDate ? Date.parse(endDate) : NaN;
  const trimByDateRange = Number.isFinite(start) && Number.isFinite(end);

  for (const repo of repos) {
    let policyName: string;
    try {
      policyName = await ensureThawedIlmPolicy(client, repo.name);
      log.debug(`Thawed ILM policy ${policyName} ensured for ${repo.name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({
        code: 'ACTION_FAILED',
        message: `Failed to create thawed ILM policy for ${repo.name}: ${msg}`,
        severity: 'warning',
        target: repo.name,
      });
      // Continue without the policy — the indices still mount, they
      // just won't have lifecycle management.
      policyName = '';
    }

    let indices: string[];
    try {
      indices = await getAllIndicesInRepo(client, repo.name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Failed to enumerate indices in ${repo.name}: ${msg}`);
      errors.push({
        code: 'ACTION_FAILED',
        message: `Failed to enumerate indices in ${repo.name}: ${msg}`,
        severity: 'warning',
        target: repo.name,
      });
      continue;
    }

    log.debug(`Repo ${repo.name}: ${indices.length} index/indices to consider`);

    for (const indexInSnapshot of indices) {
      const mountedName = stripFmClonePrefix(indexInSnapshot);
      let snapshotName: string | null;
      try {
        snapshotName = await findLatestSnapshotForIndex(
          client,
          repo.name,
          indexInSnapshot
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({
          code: 'ACTION_FAILED',
          message: `Failed to locate snapshot for ${indexInSnapshot}: ${msg}`,
          severity: 'warning',
          target: indexInSnapshot,
        });
        failed += 1;
        continue;
      }
      if (!snapshotName) {
        log.warn(`No snapshot found for index ${indexInSnapshot} in ${repo.name}`);
        failed += 1;
        continue;
      }

      const result = await mountSnapshotIndex(
        client,
        {
          repo: repo.name,
          snapshot: snapshotName,
          indexNameInSnapshot: indexInSnapshot,
          mountedName,
        },
        log
      );
      if (!result.mounted) {
        failed += 1;
        errors.push({
          code: 'ACTION_FAILED',
          message: `Failed to mount ${mountedName} from ${repo.name}/${snapshotName}`,
          severity: 'warning',
          target: mountedName,
        });
        continue;
      }

      // Best-effort policy assignment — non-fatal.
      if (policyName) {
        try {
          await assignIlmPolicy(client, mountedName, policyName);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`Failed to assign ILM policy ${policyName} to ${mountedName}: ${msg}`);
        }
      }

      // Date-overlap pruning: if the mounted index's @timestamp range
      // sits outside the requested window, delete it. We tolerate
      // "couldn't determine range" by keeping the index — matches
      // Python's defensive behavior.
      if (trimByDateRange) {
        try {
          const range = await getTimestampRange(client, [mountedName]);
          if (range.earliest && range.latest) {
            const idxStart = Date.parse(range.earliest);
            const idxEnd = Date.parse(range.latest);
            if (
              Number.isFinite(idxStart) &&
              Number.isFinite(idxEnd) &&
              (idxEnd < start || idxStart > end)
            ) {
              log.debug(
                `Trimming ${mountedName}: range ${range.earliest}..${range.latest} outside request window`
              );
              try {
                await client.indices.delete({ index: mountedName });
                skipped += 1;
                continue;
              } catch (delErr) {
                const msg = delErr instanceof Error ? delErr.message : String(delErr);
                log.warn(`Failed to trim out-of-range index ${mountedName}: ${msg}`);
              }
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.debug(`Skipping date-overlap check for ${mountedName}: ${msg}`);
        }
      }

      mounted += 1;
    }
  }

  return { mounted, skipped, failed, errors };
}
