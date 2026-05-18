/**
 * RepairMetadata action — scan repositories' actual S3 storage state
 * and reconcile the status-index `thaw_state` when the two disagree.
 *
 * Mirrors `RepairMetadata._scan_repositories` and `_repair_discrepancy` in
 *   packages/deepfreeze-core/deepfreeze_core/actions/repair_metadata.py
 *
 * Useful when:
 *   - S3 lifecycle policies moved objects without deepfreeze knowing
 *   - manual S3 operations changed storage classes
 *   - thaw operations completed but status wasn't updated
 *
 * Scope notes:
 *   The Python implementation also runs `_update_date_ranges` to populate
 *   missing `start`/`end` on mounted repos by querying their indices'
 *   `@timestamp` aggregation. That's deferred from this MVP — it needs a
 *   round-trip to the search API per mounted repo and is a separate
 *   concern from storage-state reconciliation. Easy to add in a follow-up.
 */

import type { ServiceError } from '../../common/types/errors';
import type { RepositoryDoc } from '../../common/schemas/repository';
import type { ThawState } from '../../common/constants';
import { MissingSettingsError } from '../errors';
import {
  getSettings,
  type SettingsRepoEsClient,
} from '../repositories/settings_repo';
import {
  getAllRepos,
  saveRepositoryDoc,
  type RepositoryRepoWriteEsClient,
} from '../repositories/repository_repo';
import type { StorageClient, StorageObject } from '../storage/types';

export type RepairMetadataActionEsClient = SettingsRepoEsClient &
  RepositoryRepoWriteEsClient;

/** HEAD objects in batches of this size to bound concurrent SDK calls. */
const HEAD_BATCH = 10;

/** S3 classes that don't need restore. */
const INSTANT_ACCESS_CLASSES = new Set([
  'STANDARD',
  'STANDARD_IA',
  'ONEZONE_IA',
  'INTELLIGENT_TIERING',
  'REDUCED_REDUNDANCY',
]);

/**
 * Storage-state snapshot for one repo's bucket+base_path. The counts
 * partition `total_objects` between instant-access, archive (glacier),
 * and archive-in-flight (restoring).
 */
export interface ActualStorageState {
  total_objects: number;
  /** Map of S3 storage_class → count. */
  storage_classes: Record<string, number>;
  instant_access: number;
  glacier: number;
  restoring: number;
}

export interface DiscrepancyRecord {
  repo: string;
  bucket: string;
  base_path: string;
  recorded_state: ThawState;
  /** Suggested state based on actual storage, or null on inspection error. */
  actual_state: ThawState | null;
  total_objects: number;
  storage_classes: Record<string, number>;
  instant_access: number;
  glacier: number;
  restoring: number;
  /** Set when the storage inspection itself failed. */
  error?: string;
}

export interface RepairOutcome {
  repo: string;
  from: ThawState;
  to: ThawState;
  success: boolean;
  error?: string;
}

export interface RepairResult {
  success: boolean;
  dry_run: boolean;
  /** Every repo with a thaw_state disagreement (or inspection error). */
  discrepancies: DiscrepancyRecord[];
  /** Successful state flips. Empty in dry-run. */
  repaired: RepairOutcome[];
  /** Per-repo persistence failures during the actual repair. */
  failed: RepairOutcome[];
  errors: ServiceError[];
  started_at: string;
  completed_at: string;
}

export interface RunRepairMetadataOptions {
  log?: { debug: (m: string) => void; warn: (m: string) => void };
}

const NOOP_LOG = { debug: () => {}, warn: () => {} };

async function loadInitializedSettings(
  client: RepairMetadataActionEsClient
): Promise<void> {
  const settings = await getSettings(client);
  if (!settings) {
    throw new MissingSettingsError('Settings document not found in status index');
  }
}

/**
 * For one bucket+base_path, list every object and classify by storage
 * class. Archive-tier objects with `ongoing-request="true"` count as
 * `restoring`; the rest are `glacier`. Anything in an instant-access
 * tier counts as `instant_access`.
 *
 * Mirrors `_determine_actual_state` in Python; INTELLIGENT_TIERING
 * stays in instant_access because its hot sub-tier is the common case
 * and the Python implementation classifies it that way.
 */
async function determineActualState(
  storage: StorageClient,
  bucket: string,
  base_path: string
): Promise<ActualStorageState> {
  const normalized = base_path.replace(/^\/+|\/+$/g, '');
  const prefix = normalized ? `${normalized}/` : '';

  const objects: StorageObject[] = await storage.listObjects(bucket, prefix);
  const result: ActualStorageState = {
    total_objects: objects.length,
    storage_classes: {},
    instant_access: 0,
    glacier: 0,
    restoring: 0,
  };

  // First pass: tally storage classes, identify archive objects needing HEAD.
  const archiveObjects: StorageObject[] = [];
  for (const obj of objects) {
    const sc = obj.storage_class || 'STANDARD';
    result.storage_classes[sc] = (result.storage_classes[sc] ?? 0) + 1;
    if (INSTANT_ACCESS_CLASSES.has(sc)) {
      result.instant_access += 1;
    } else {
      archiveObjects.push(obj);
    }
  }

  // Second pass: HEAD each archive object to see if it's restoring.
  for (let i = 0; i < archiveObjects.length; i += HEAD_BATCH) {
    const batch = archiveObjects.slice(i, i + HEAD_BATCH);
    const states = await Promise.all(
      batch.map(async (obj) => {
        try {
          return await storage.headObject(bucket, obj.key);
        } catch {
          return null;
        }
      })
    );
    for (const state of states) {
      if (state && state.restore && state.restore.ongoing) {
        result.restoring += 1;
      } else {
        result.glacier += 1;
      }
    }
  }

  return result;
}

/**
 * Compare a repo's recorded thaw_state against its actual storage
 * distribution and decide whether a state flip is warranted.
 *
 * Returns `null` when the recorded state is consistent with the
 * observed storage. The rules mirror Python exactly:
 *   - active/thawed: should be instant-access; flag if all glacier or
 *     some restoring.
 *   - frozen: should be archive; flag if all instant-access or some
 *     restoring.
 *   - thawing: in-flight; flag if all-glacier (failed) or all-accessible
 *     (completed).
 *   - expired: archive expected; flag if all instant-access.
 */
export function inferDiscrepancy(
  recorded: ThawState,
  actual: ActualStorageState
): ThawState | null {
  const total = actual.total_objects;
  if (total === 0) return null;

  switch (recorded) {
    case 'active':
    case 'thawed':
      if (actual.glacier === total) return 'frozen';
      if (actual.restoring > 0) return 'thawing';
      return null;

    case 'frozen':
      if (actual.instant_access === total) return 'thawed';
      if (actual.restoring > 0) return 'thawing';
      return null;

    case 'thawing':
      if (actual.glacier === total) return 'frozen';
      if (actual.instant_access === total) return 'thawed';
      return null;

    case 'expired':
      if (actual.instant_access === total) return 'thawed';
      return null;

    default:
      return null;
  }
}

async function scanRepositories(
  client: RepairMetadataActionEsClient,
  storage: StorageClient,
  log: { debug: (m: string) => void; warn: (m: string) => void }
): Promise<{ repos: RepositoryDoc[]; discrepancies: DiscrepancyRecord[] }> {
  const repos = await getAllRepos(client);
  const discrepancies: DiscrepancyRecord[] = [];

  for (const repo of repos) {
    log.debug(`Scanning ${repo.name} (${repo.bucket}/${repo.base_path})`);
    try {
      const actual = await determineActualState(storage, repo.bucket, repo.base_path);
      const suggested = inferDiscrepancy(repo.thaw_state, actual);
      if (suggested !== null) {
        discrepancies.push({
          repo: repo.name,
          bucket: repo.bucket,
          base_path: repo.base_path,
          recorded_state: repo.thaw_state,
          actual_state: suggested,
          total_objects: actual.total_objects,
          storage_classes: actual.storage_classes,
          instant_access: actual.instant_access,
          glacier: actual.glacier,
          restoring: actual.restoring,
        });
        log.debug(
          `Discrepancy ${repo.name}: recorded=${repo.thaw_state}, suggested=${suggested}`
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Inspection failed for ${repo.name}: ${msg}`);
      discrepancies.push({
        repo: repo.name,
        bucket: repo.bucket,
        base_path: repo.base_path,
        recorded_state: repo.thaw_state,
        actual_state: null,
        total_objects: 0,
        storage_classes: {},
        instant_access: 0,
        glacier: 0,
        restoring: 0,
        error: msg,
      });
    }
  }

  return { repos, discrepancies };
}

/**
 * Apply a single discrepancy by upserting the RepositoryDoc with the
 * suggested thaw_state. `is_thawed` and `is_mounted` flip alongside to
 * stay consistent with the new state:
 *   - thawed/thawing → is_thawed=true
 *   - frozen → is_mounted=false (the snapshot repo is unregistered)
 *
 * Mirrors `_repair_discrepancy` in Python (without re-fetching the
 * RepositoryDoc — we already have it in scanRepositories' results).
 */
async function applyRepair(
  client: RepairMetadataActionEsClient,
  repo: RepositoryDoc,
  newState: ThawState
): Promise<void> {
  const next: RepositoryDoc = {
    ...repo,
    thaw_state: newState,
    is_thawed: newState === 'thawed' || newState === 'thawing',
    is_mounted: newState === 'frozen' ? false : repo.is_mounted,
  };
  await saveRepositoryDoc(client, next);
}

export async function runRepairMetadataDryRun(
  client: RepairMetadataActionEsClient,
  storage: StorageClient,
  options: RunRepairMetadataOptions = {}
): Promise<RepairResult> {
  const log = options.log ?? NOOP_LOG;
  const started_at = new Date().toISOString();
  await loadInitializedSettings(client);
  const { discrepancies } = await scanRepositories(client, storage, log);

  return {
    success: true,
    dry_run: true,
    discrepancies,
    repaired: [],
    failed: [],
    errors: [],
    started_at,
    completed_at: new Date().toISOString(),
  };
}

export async function runRepairMetadata(
  client: RepairMetadataActionEsClient,
  storage: StorageClient,
  options: RunRepairMetadataOptions = {}
): Promise<RepairResult> {
  const log = options.log ?? NOOP_LOG;
  const started_at = new Date().toISOString();
  await loadInitializedSettings(client);
  const { repos, discrepancies } = await scanRepositories(client, storage, log);

  const repoByName = new Map(repos.map((r) => [r.name, r]));
  const repaired: RepairOutcome[] = [];
  const failed: RepairOutcome[] = [];
  const errors: ServiceError[] = [];

  for (const d of discrepancies) {
    if (d.error || d.actual_state === null) {
      // Inspection failed; can't decide what to flip to.
      errors.push({
        code: 'ACTION_FAILED',
        message: `Cannot repair ${d.repo}: ${d.error ?? 'no suggested state'}`,
        severity: 'warning',
        target: d.repo,
      });
      continue;
    }
    const repo = repoByName.get(d.repo);
    if (!repo) {
      // Vanishingly unlikely (scan just produced it) — bail gracefully.
      errors.push({
        code: 'ACTION_FAILED',
        message: `Repo ${d.repo} disappeared during repair`,
        severity: 'warning',
        target: d.repo,
      });
      continue;
    }
    try {
      await applyRepair(client, repo, d.actual_state);
      repaired.push({
        repo: d.repo,
        from: d.recorded_state,
        to: d.actual_state,
        success: true,
      });
      log.debug(`Repaired ${d.repo}: ${d.recorded_state} → ${d.actual_state}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Failed to repair ${d.repo}: ${msg}`);
      failed.push({
        repo: d.repo,
        from: d.recorded_state,
        to: d.actual_state,
        success: false,
        error: msg,
      });
      errors.push({
        code: 'ACTION_FAILED',
        message: `Failed to persist ${d.repo}: ${msg}`,
        severity: 'warning',
        target: d.repo,
      });
    }
  }

  return {
    success: true,
    dry_run: false,
    discrepancies,
    repaired,
    failed,
    errors,
    started_at,
    completed_at: new Date().toISOString(),
  };
}
