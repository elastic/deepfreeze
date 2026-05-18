/**
 * Refreeze action — undo a completed thaw by deleting the mounted
 * searchable-snapshot indices, unmounting the repositories, and
 * flipping the thaw request's status to `refrozen`.
 *
 * Mirrors `Refreeze.do_action` in
 *   packages/deepfreeze-core/deepfreeze_core/actions/refreeze.py
 * with one deliberate simplification: ILM policy cleanup is handled by
 * Cleanup, not Refreeze. Refreeze leaves any versioned ILM policies in
 * place (some may still be bound to other indices); the orphaned-policy
 * sweep is Cleanup's responsibility — see cleanup.ts.
 *
 * Per-repo failures (individual index deletes, individual unmounts)
 * degrade to warnings in the result's `errors[]`. If every repo
 * succeeded the thaw request is marked refrozen; if any failed it
 * stays at `completed` so the user can retry.
 */

import type { ServiceError } from '../../common/types/errors';
import type { RepositoryDoc } from '../../common/schemas/repository';
import type { ThawRequestDoc } from '../../common/schemas/thaw_request';
import { ActionError, MissingSettingsError } from '../errors';
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
  deleteThawRequest as _del,
  getThawRequest,
  listThawRequests,
  saveThawRequest,
  type ThawRequestRepoWriteEsClient,
} from '../repositories/thaw_request_repo';

/** Subset of `indices.*` ES methods needed to tear down searchable-snapshot indices. */
export interface RefreezeIndicesEsClient {
  indices: {
    getSettings: (params: { index: string }) => Promise<Record<string, unknown>>;
    getDataStream: (params: { name: string }) => Promise<{
      data_streams?: Array<{ name: string; indices?: Array<{ index_name: string }> }>;
    }>;
    deleteDataStream: (params: { name: string }) => Promise<unknown>;
    exists: (params: { index: string }) => Promise<boolean> | boolean;
    delete: (params: { index: string }) => Promise<unknown>;
  };
}

export type RefreezeActionEsClient = SettingsRepoEsClient &
  RepositoryRepoWriteEsClient &
  ThawRequestRepoWriteEsClient &
  SnapshotRepoEsClient &
  RefreezeIndicesEsClient;

export interface RefreezeConfig {
  /** Refreeze this single request. Mutually exclusive with `all_requests`. */
  request_id?: string;
  /** Refreeze every completed thaw request. */
  all_requests?: boolean;
}

export interface RunRefreezeOptions {
  log?: { debug: (m: string) => void; warn: (m: string) => void };
}

const NOOP_LOG = { debug: () => {}, warn: () => {} };

export interface RefreezeStepRecord {
  type: 'thaw_request' | 'repository' | 'index' | 'data_stream';
  action: 'would_refreeze' | 'refrozen' | 'deleted' | 'unmounted' | 'frozen' | 'skipped' | 'rejected';
  name?: string;
  detail?: string;
}

export interface RefreezeResult {
  success: boolean;
  dry_run: boolean;
  /** Thaw request IDs that were (or would be) flipped to refrozen. */
  refrozen_requests: string[];
  /** Requests we wanted to process but skipped (e.g. wrong status). */
  rejected_requests: Array<{ request_id: string; reason: string }>;
  steps: RefreezeStepRecord[];
  errors: ServiceError[];
  started_at: string;
  completed_at: string;
}

async function loadInitializedSettings(client: RefreezeActionEsClient): Promise<void> {
  const settings = await getSettings(client);
  if (!settings) {
    throw new MissingSettingsError('Settings document not found in status index');
  }
}

interface SearchableSnapshotIndexInfo {
  indices: string[];
  dataStreams: string[];
}

/**
 * Find searchable-snapshot indices whose `store.snapshot.repository_name`
 * matches `repoName`, and split them into standalone indices vs.
 * data-stream backing indices. Data streams must be deleted via the
 * data-stream API, not by deleting their `.ds-*` backing indices
 * directly.
 */
async function findSearchableSnapshotIndices(
  client: RefreezeActionEsClient,
  repoName: string
): Promise<SearchableSnapshotIndexInfo> {
  const settingsResp = await client.indices.getSettings({ index: '*' });
  const all: string[] = [];
  for (const [indexName, raw] of Object.entries(settingsResp)) {
    const store = (
      (raw as { settings?: { index?: { store?: Record<string, unknown> } } })
        .settings?.index?.store ?? {}
    ) as { type?: string; snapshot?: { repository_name?: string } };
    if (store.type === 'snapshot' && store.snapshot?.repository_name === repoName) {
      all.push(indexName);
    }
  }
  if (all.length === 0) {
    return { indices: [], dataStreams: [] };
  }

  // Resolve which data streams own any of these backing indices.
  let dsToDelete: Set<string>;
  try {
    const dsResp = await client.indices.getDataStream({ name: '*' });
    const ssSet = new Set(all);
    dsToDelete = new Set();
    for (const ds of dsResp.data_streams ?? []) {
      const backing = (ds.indices ?? []).map((i) => i.index_name);
      if (backing.some((b) => ssSet.has(b))) dsToDelete.add(ds.name);
    }
  } catch {
    // Data-stream API may be unavailable; fall back to no data streams.
    dsToDelete = new Set<string>();
  }

  const dsBackingIndices = new Set<string>();
  if (dsToDelete.size > 0) {
    const dsResp = await client.indices.getDataStream({ name: '*' });
    for (const ds of dsResp.data_streams ?? []) {
      if (dsToDelete.has(ds.name)) {
        for (const idx of ds.indices ?? []) dsBackingIndices.add(idx.index_name);
      }
    }
  }

  const standalone = all.filter((i) => !dsBackingIndices.has(i));
  return { indices: standalone, dataStreams: Array.from(dsToDelete) };
}

/** Result of refreezing a single repo within a request. */
interface RepoRefreezeOutcome {
  repo: string;
  success: boolean;
  deleted_indices: string[];
  deleted_data_streams: string[];
  error?: string;
}

async function refreezeOneRepo(
  client: RefreezeActionEsClient,
  repo: RepositoryDoc,
  steps: RefreezeStepRecord[],
  log: { warn: (m: string) => void }
): Promise<RepoRefreezeOutcome> {
  const outcome: RepoRefreezeOutcome = {
    repo: repo.name,
    success: false,
    deleted_indices: [],
    deleted_data_streams: [],
  };

  try {
    const { indices, dataStreams } = await findSearchableSnapshotIndices(client, repo.name);

    for (const ds of dataStreams) {
      try {
        await client.indices.deleteDataStream({ name: ds });
        outcome.deleted_data_streams.push(ds);
        steps.push({ type: 'data_stream', action: 'deleted', name: ds });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`Failed to delete data stream ${ds}: ${msg}`);
        steps.push({ type: 'data_stream', action: 'skipped', name: ds, detail: msg });
      }
    }

    for (const idx of indices) {
      try {
        const exists = await client.indices.exists({ index: idx });
        if (!exists) continue;
        await client.indices.delete({ index: idx });
        outcome.deleted_indices.push(idx);
        steps.push({ type: 'index', action: 'deleted', name: idx });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`Failed to delete index ${idx}: ${msg}`);
        steps.push({ type: 'index', action: 'skipped', name: idx, detail: msg });
      }
    }

    await deleteSnapshotRepository(client, repo.name);
    steps.push({ type: 'repository', action: 'unmounted', name: repo.name });

    await saveRepositoryDoc(client, {
      ...repo,
      is_thawed: false,
      is_mounted: false,
      thaw_state: 'frozen',
      thawed_at: null,
      expires_at: null,
    });
    steps.push({ type: 'repository', action: 'frozen', name: repo.name });

    outcome.success = true;
  } catch (err) {
    outcome.error = err instanceof Error ? err.message : String(err);
  }
  return outcome;
}

/**
 * Resolve which thaw requests to act on, given the config. Throws
 * `ActionError` for invalid argument combinations.
 */
async function resolveTargetRequests(
  client: RefreezeActionEsClient,
  config: RefreezeConfig
): Promise<ThawRequestDoc[]> {
  if (config.all_requests && config.request_id) {
    throw new ActionError("Cannot combine 'all_requests' with a specific 'request_id'");
  }
  if (!config.all_requests && !config.request_id) {
    throw new ActionError("Refreeze requires either 'request_id' or 'all_requests: true'");
  }

  if (config.all_requests) {
    const all = await listThawRequests(client);
    return all.filter((r) => r.status === 'completed');
  }

  const req = await getThawRequest(client, config.request_id!);
  return req ? [req] : [];
}

/**
 * Build the would-be RefreezeResult without changing the cluster.
 *
 * Lists target requests + their repos and previews the steps. It does
 * NOT scan for backing indices; that requires the live `indices.*`
 * calls and is the kind of thing we run during real Refreeze only.
 */
export async function runRefreezeDryRun(
  client: RefreezeActionEsClient,
  config: RefreezeConfig
): Promise<RefreezeResult> {
  const started_at = new Date().toISOString();

  await loadInitializedSettings(client);
  const targets = await resolveTargetRequests(client, config);

  const steps: RefreezeStepRecord[] = [];
  const rejected: RefreezeResult['rejected_requests'] = [];
  const willRefreeze: string[] = [];

  if (config.request_id && targets.length === 0) {
    rejected.push({ request_id: config.request_id, reason: 'not found' });
  }

  for (const req of targets) {
    if (req.status !== 'completed') {
      rejected.push({
        request_id: req.request_id,
        reason:
          req.status === 'refrozen'
            ? 'already refrozen'
            : `status is '${req.status}', must be 'completed'`,
      });
      steps.push({
        type: 'thaw_request',
        action: 'rejected',
        name: req.request_id,
        detail: req.status,
      });
      continue;
    }

    willRefreeze.push(req.request_id);
    steps.push({
      type: 'thaw_request',
      action: 'would_refreeze',
      name: req.request_id,
      detail: `${req.repos.length} repos`,
    });
  }

  return {
    success: true,
    dry_run: true,
    refrozen_requests: willRefreeze,
    rejected_requests: rejected,
    steps,
    errors: [],
    started_at,
    completed_at: new Date().toISOString(),
  };
}

/**
 * Real refreeze: for each target request, refreeze every repo it
 * references and flip the request to `refrozen` iff every repo
 * succeeded.
 */
export async function runRefreeze(
  client: RefreezeActionEsClient,
  config: RefreezeConfig,
  options: RunRefreezeOptions = {}
): Promise<RefreezeResult> {
  const log = options.log ?? NOOP_LOG;
  const started_at = new Date().toISOString();

  await loadInitializedSettings(client);
  const targets = await resolveTargetRequests(client, config);

  const steps: RefreezeStepRecord[] = [];
  const errors: ServiceError[] = [];
  const refrozen: string[] = [];
  const rejected: RefreezeResult['rejected_requests'] = [];

  if (config.request_id && targets.length === 0) {
    rejected.push({ request_id: config.request_id, reason: 'not found' });
  }

  // We need RepositoryDocs by name to refreeze them. Load all once.
  const allRepoDocs = await getAllRepos(client);
  const repoByName = new Map(allRepoDocs.map((r) => [r.name, r]));

  for (const req of targets) {
    if (req.status !== 'completed') {
      rejected.push({
        request_id: req.request_id,
        reason:
          req.status === 'refrozen'
            ? 'already refrozen'
            : `status is '${req.status}', must be 'completed'`,
      });
      steps.push({
        type: 'thaw_request',
        action: 'rejected',
        name: req.request_id,
        detail: req.status,
      });
      continue;
    }

    let allRepoOk = true;
    for (const repoName of req.repos) {
      const repoDoc = repoByName.get(repoName);
      if (!repoDoc) {
        log.warn(`Repo ${repoName} referenced by ${req.request_id} not in status index`);
        errors.push({
          code: 'ACTION_FAILED',
          message: `Repo ${repoName} not found in status index; cannot refreeze.`,
          severity: 'warning',
          target: repoName,
        });
        steps.push({ type: 'repository', action: 'skipped', name: repoName });
        allRepoOk = false;
        continue;
      }
      const outcome = await refreezeOneRepo(client, repoDoc, steps, log);
      if (!outcome.success) {
        allRepoOk = false;
        errors.push({
          code: 'ACTION_FAILED',
          message: `Failed to refreeze ${repoName}: ${outcome.error}`,
          severity: 'warning',
          target: repoName,
        });
      }
    }

    if (allRepoOk) {
      await saveThawRequest(client, { ...req, status: 'refrozen' });
      refrozen.push(req.request_id);
      steps.push({ type: 'thaw_request', action: 'refrozen', name: req.request_id });
    } else {
      steps.push({
        type: 'thaw_request',
        action: 'skipped',
        name: req.request_id,
        detail: 'one or more repos failed; status left at completed',
      });
    }
  }

  return {
    success: true,
    dry_run: false,
    refrozen_requests: refrozen,
    rejected_requests: rejected,
    steps,
    errors,
    started_at,
    completed_at: new Date().toISOString(),
  };
}

// Re-export to mute "unused" linting if isolated builds drop the import.
export { _del as _deleteThawRequest };
