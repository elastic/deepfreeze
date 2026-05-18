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
import { MissingSettingsError } from '../errors';
import {
  getSettings,
  type SettingsRepoEsClient,
} from '../repositories/settings_repo';
import {
  findReposByDateRange,
  saveRepositoryDoc,
  type RepositoryRepoWriteEsClient,
} from '../repositories/repository_repo';
import {
  saveThawRequest,
  type ThawRequestRepoWriteEsClient,
} from '../repositories/thaw_request_repo';
import type { RetrievalTier, StorageClient } from '../storage/types';

/**
 * Restore-window length, in days, and Glacier retrieval tier. Hard-coded
 * for Step 2; Phase 4 Step 4 will surface both as user-facing knobs in
 * the Thaw UI and thread them through `ThawConfig`.
 */
export const DEFAULT_RESTORE_DAYS = 7;
export const DEFAULT_RETRIEVAL_TIER: RetrievalTier = 'Standard';

/** Restore objects in batches of this size to bound concurrent SDK calls. */
const RESTORE_BATCH = 10;

export type ThawActionEsClient = SettingsRepoEsClient &
  RepositoryRepoWriteEsClient &
  ThawRequestRepoWriteEsClient;

export interface ThawConfig {
  /** ISO 8601 inclusive start of the date range to thaw. */
  start_date: string;
  /** ISO 8601 inclusive end of the date range to thaw. */
  end_date: string;
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
  log: { debug: (m: string) => void; warn: (m: string) => void }
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
          days: DEFAULT_RESTORE_DAYS,
          tier: DEFAULT_RETRIEVAL_TIER,
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
  const expiresAt = new Date(
    now().getTime() + DEFAULT_RESTORE_DAYS * 24 * 60 * 60 * 1000
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
      const outcome = await restoreOneRepo(storage, repo, steps, log);
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
