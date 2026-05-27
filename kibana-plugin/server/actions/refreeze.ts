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
    exists: (params: { index: string }) => Promise<boolean> | boolean;
    delete: (params: { index: string }) => Promise<unknown>;
    /**
     * Surgical data-stream edit. Used to detach a single backing index
     * from its data stream (so we can then `indices.delete` it) without
     * destroying the rest of the stream. Refreeze never deletes a whole
     * data stream — see comment on `refreezeOneRepo` for why.
     */
    modifyDataStream: (params: {
      body: {
        actions: Array<{
          add_backing_index?: { data_stream: string; index: string };
          remove_backing_index?: { data_stream: string; index: string };
        }>;
      };
    }) => Promise<unknown>;
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
  action:
    | 'would_refreeze'
    | 'refrozen'
    | 'deleted'
    | 'detached'
    | 'unmounted'
    | 'frozen'
    | 'skipped'
    | 'rejected';
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

interface SearchableSnapshotIndex {
  /** Index name (the literal ES index, including any `.ds-` prefix). */
  name: string;
  /**
   * Name of the data stream this index is currently a backing index of,
   * or `null` if it's standalone. Drives the detach-before-delete
   * decision in `refreezeOneRepo`.
   */
  datastream: string | null;
}

/**
 * Find searchable-snapshot indices whose `store.snapshot.repository_name`
 * matches `repoName`, and annotate each with the data stream it
 * currently belongs to (if any).
 *
 * The earlier shape of this function returned a list of data streams
 * to *delete* — that turned out to be catastrophically wrong, because
 * a single thawed backing index pinned the entire data stream's hot
 * indices for deletion alongside it. See `refreezeOneRepo` for the
 * surgical replacement.
 */
async function findSearchableSnapshotIndices(
  client: RefreezeActionEsClient,
  repoName: string
): Promise<SearchableSnapshotIndex[]> {
  const settingsResp = await client.indices.getSettings({ index: '*' });
  const ssNames: string[] = [];
  for (const [indexName, raw] of Object.entries(settingsResp)) {
    const store = (
      (raw as { settings?: { index?: { store?: Record<string, unknown> } } })
        .settings?.index?.store ?? {}
    ) as { type?: string; snapshot?: { repository_name?: string } };
    if (store.type === 'snapshot' && store.snapshot?.repository_name === repoName) {
      ssNames.push(indexName);
    }
  }
  if (ssNames.length === 0) return [];

  // Build a `backing-index → data-stream-name` lookup so we can
  // annotate each SS index with its current data-stream membership
  // (if any). One scan over all data streams; cheap.
  const indexToStream = new Map<string, string>();
  try {
    const dsResp = await client.indices.getDataStream({ name: '*' });
    for (const ds of dsResp.data_streams ?? []) {
      for (const idx of ds.indices ?? []) {
        indexToStream.set(idx.index_name, ds.name);
      }
    }
  } catch {
    // Data-stream API may be unavailable on some deployments — treat
    // every SS index as standalone in that case.
  }

  return ssNames.map((name) => ({
    name,
    datastream: indexToStream.get(name) ?? null,
  }));
}

/** Result of refreezing a single repo within a request. */
interface RepoRefreezeOutcome {
  repo: string;
  success: boolean;
  deleted_indices: string[];
  detached_indices: string[];
  error?: string;
}

/**
 * Refreeze a single repo by tearing down every searchable-snapshot
 * index referencing it, then unregistering the snapshot repo from ES.
 *
 * For each SS index:
 *   - If it's a backing index of a data stream: detach it via
 *     `indices.modify_data_stream` (`remove_backing_index`), then
 *     delete the now-standalone index. This is the surgical path —
 *     the data stream itself and any sibling backing indices are
 *     untouched.
 *   - If it's standalone: delete directly.
 *
 * The prior implementation deleted whole data streams whenever any
 * backing index referenced the repo — catastrophic, since it took
 * the active hot backing indices down with the thawed one. NEVER
 * delete a data stream during refreeze.
 *
 * If ANY index can't be torn down, we skip the `deleteSnapshotRepository`
 * step — ES would reject it with `repository_conflict_exception`
 * anyway, and surfacing the cleaner per-index failure is more useful
 * than papering it over with the cascade.
 */
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
    detached_indices: [],
  };

  try {
    const ssIndices = await findSearchableSnapshotIndices(client, repo.name);

    let perIndexFailures = 0;
    for (const { name, datastream } of ssIndices) {
      // Step 1: detach from the data stream if attached. A failure
      // here means we won't be able to delete the index below, so
      // record it and move on.
      if (datastream) {
        try {
          await client.indices.modifyDataStream({
            body: {
              actions: [
                {
                  remove_backing_index: {
                    data_stream: datastream,
                    index: name,
                  },
                },
              ],
            },
          });
          outcome.detached_indices.push(name);
          steps.push({
            type: 'index',
            action: 'detached',
            name,
            detail: `removed from data stream ${datastream}`,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`Failed to detach ${name} from data stream ${datastream}: ${msg}`);
          steps.push({
            type: 'index',
            action: 'skipped',
            name,
            detail: `detach from ${datastream} failed: ${msg}`,
          });
          perIndexFailures += 1;
          continue;
        }
      }

      // Step 2: delete the (now-standalone) index.
      try {
        const exists = await client.indices.exists({ index: name });
        if (!exists) continue;
        await client.indices.delete({ index: name });
        outcome.deleted_indices.push(name);
        steps.push({ type: 'index', action: 'deleted', name });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`Failed to delete index ${name}: ${msg}`);
        steps.push({ type: 'index', action: 'skipped', name, detail: msg });
        perIndexFailures += 1;
      }
    }

    if (perIndexFailures > 0) {
      // Don't even try to unregister the repo — ES will reject with
      // repository_conflict_exception because the SS indices we couldn't
      // delete still reference it. The per-index `skipped` steps above
      // already explain why, and the caller's rejected_requests entry
      // surfaces the detail to the operator.
      outcome.error = `${perIndexFailures} index/indices could not be torn down`;
      return outcome;
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
    // Per-request failure details so the rejection reason can carry the
    // specific repo errors back to the UI. Without this the toast just
    // says "unknown reason" while the actual cause is buried in errors[].
    const thisReqFailures: string[] = [];
    for (const repoName of req.repos) {
      const repoDoc = repoByName.get(repoName);
      if (!repoDoc) {
        log.warn(`Repo ${repoName} referenced by ${req.request_id} not in status index`);
        const detail = `${repoName}: not found in status index`;
        thisReqFailures.push(detail);
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
        const detail = `${repoName}: ${outcome.error ?? 'unknown error'}`;
        thisReqFailures.push(detail);
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
      rejected.push({
        request_id: req.request_id,
        reason:
          thisReqFailures.length > 0
            ? thisReqFailures.join('; ')
            : 'one or more repos failed to refreeze',
      });
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
