/**
 * ILM policy inspection.
 *
 * Mirrors `Status._get_ilm_policies` in
 *   packages/deepfreeze-core/deepfreeze_core/actions/status.py
 *
 * Returns only policies that reference a deepfreeze-managed snapshot
 * repository via a `searchable_snapshot` phase action.
 */

import type { IlmPolicyInfo } from '../../common/types/status';

export interface IlmRepoEsClient {
  ilm: {
    getLifecycle: (params?: { name?: string }) => Promise<Record<string, unknown>>;
  };
}

/** Write methods needed for putting + deleting ILM policies. */
export interface IlmRepoWriteEsClient extends IlmRepoEsClient {
  ilm: IlmRepoEsClient['ilm'] & {
    putLifecycle: (params: {
      name: string;
      policy: Record<string, unknown>;
    }) => Promise<unknown>;
    deleteLifecycle: (params: { name: string }) => Promise<unknown>;
  };
}

/**
 * Shape of each entry returned by this helper. Compatible with the
 * loose `IlmPolicyInfo` type but documents the actual known fields.
 */
export interface DeepfreezeIlmPolicyInfo extends IlmPolicyInfo {
  name: string;
  repository: string;
  indices_count: number;
  data_streams_count: number;
  templates_count: number;
}

export interface IlmPolicyEntry {
  policy?: {
    phases?: Record<
      string,
      {
        actions?: {
          searchable_snapshot?: { snapshot_repository?: string };
          [k: string]: unknown;
        };
      }
    >;
  };
  in_use_by?: {
    indices?: unknown[];
    data_streams?: unknown[];
    composable_templates?: unknown[];
  };
}

/**
 * Filter ILM policies down to those that drive a deepfreeze-managed
 * snapshot repository (i.e. their `searchable_snapshot` phase action
 * targets a repo whose name starts with `repoNamePrefix`).
 *
 * Like the Python source, a single policy contributes at most one row
 * even when several phases reference matching repositories.
 */
export async function getDeepfreezeIlmPolicies(
  client: IlmRepoEsClient,
  repoNamePrefix: string
): Promise<DeepfreezeIlmPolicyInfo[]> {
  const allPolicies = (await client.ilm.getLifecycle()) as Record<
    string,
    IlmPolicyEntry
  >;

  const matches: DeepfreezeIlmPolicyInfo[] = [];

  for (const [policyName, policyData] of Object.entries(allPolicies)) {
    const phases = policyData.policy?.phases ?? {};

    for (const phaseConfig of Object.values(phases)) {
      const snapshotRepo = phaseConfig.actions?.searchable_snapshot?.snapshot_repository;
      if (snapshotRepo && repoNamePrefix && snapshotRepo.startsWith(repoNamePrefix)) {
        const inUseBy = policyData.in_use_by ?? {};
        matches.push({
          name: policyName,
          repository: snapshotRepo,
          indices_count: inUseBy.indices?.length ?? 0,
          data_streams_count: inUseBy.data_streams?.length ?? 0,
          templates_count: inUseBy.composable_templates?.length ?? 0,
        });
        break; // one row per policy
      }
    }
  }

  return matches;
}

/**
 * Return every ILM policy name in the cluster, sorted for stable
 * display. Used by the Setup wizard's dropdown so the operator can
 * pick an existing policy or type a new one.
 */
export async function getAllIlmPolicyNames(
  client: IlmRepoEsClient
): Promise<string[]> {
  const allPolicies = (await client.ilm.getLifecycle()) as Record<string, unknown>;
  return Object.keys(allPolicies).sort();
}

/**
 * Fetch a single ILM policy by name. Returns `null` on 404; other
 * errors propagate so the caller can decide.
 */
export async function getIlmPolicy(
  client: IlmRepoEsClient,
  name: string
): Promise<IlmPolicyEntry | null> {
  try {
    const result = (await client.ilm.getLifecycle({ name })) as Record<string, IlmPolicyEntry>;
    return result[name] ?? null;
  } catch (err) {
    if (isNotFound(err)) {
      return null;
    }
    throw err;
  }
}

/**
 * The default tiering strategy used when Setup needs to bootstrap a
 * brand-new base ILM policy (because the user-selected name didn't yet
 * exist in the cluster). Hot → Cold (30d) → Frozen (365d, searchable
 * snapshot to the first deepfreeze repo) → Delete (with
 * delete_searchable_snapshot=false so the underlying snapshot survives).
 *
 * Mirrors the same dictionary in
 *   packages/deepfreeze-core/deepfreeze_core/utilities.py
 *     — create_or_update_ilm_policy().
 *
 * Note on the body shape: the @elastic/elasticsearch v9 client's
 * `putLifecycle({ name, policy })` already wraps `policy` into the
 * `{policy: {...}}` envelope that the underlying REST API expects.
 * This helper therefore returns just the inner `{phases: {...}}` shape;
 * double-wrapping causes ES to reject the request with
 * `[lifecycle_policy] unknown field [policy]`.
 */
export function defaultIlmPolicyBody(repoName: string): Record<string, unknown> {
  return {
    phases: {
      hot: {
        min_age: '0ms',
        actions: { rollover: { max_size: '45gb', max_age: '7d' } },
      },
      cold: {
        min_age: '30d',
        actions: { set_priority: { priority: 0 } },
      },
      frozen: {
        min_age: '365d',
        actions: { searchable_snapshot: { snapshot_repository: repoName } },
      },
      delete: {
        min_age: '0d',
        actions: { delete: { delete_searchable_snapshot: false } },
      },
    },
  };
}

/**
 * Create a versioned ILM policy by deep-cloning an existing policy body
 * and retargeting every `searchable_snapshot.snapshot_repository` to the
 * new repository.
 *
 * The new policy is written at `<basePolicyName>-<suffix>` and returned.
 * Mirrors `create_versioned_ilm_policy` in
 *   packages/deepfreeze-core/deepfreeze_core/utilities.py
 *
 * Why versioned policies matter: indices are bound to an ILM policy by
 * name. Mutating the base policy to point at the new repo would cause
 * indices created under the old repo to start snapshotting to the new
 * one on their next phase transition — silently shifting prior data's
 * snapshots across repos. Versioning isolates each rotation's policy so
 * existing indices keep using whatever versioned policy they were
 * created with.
 */
export async function createVersionedIlmPolicy(
  client: IlmRepoWriteEsClient,
  basePolicyName: string,
  basePolicyBody: { phases?: Record<string, unknown> } | Record<string, unknown>,
  newRepoName: string,
  suffix: string
): Promise<string> {
  const newPolicyName = `${basePolicyName}-${suffix}`;
  const cloned = JSON.parse(JSON.stringify(basePolicyBody)) as {
    phases?: Record<
      string,
      { actions?: { searchable_snapshot?: { snapshot_repository?: string } } }
    >;
  };
  const phases = cloned.phases ?? {};
  for (const phaseConfig of Object.values(phases)) {
    const ss = phaseConfig.actions?.searchable_snapshot;
    if (ss) {
      ss.snapshot_repository = newRepoName;
    }
  }
  await client.ilm.putLifecycle({ name: newPolicyName, policy: cloned });
  return newPolicyName;
}

/**
 * Inspect an ILM policy's `in_use_by` and decide whether it is safe to
 * delete. Safe means zero references from `indices`, `data_streams`,
 * AND `composable_templates`. Mirrors `is_policy_safe_to_delete` in
 *   packages/deepfreeze-core/deepfreeze_core/utilities.py
 *
 * Returns `false` when the policy is missing (defensive — don't claim
 * an absent policy is "safe to delete", report it to the caller as
 * unsafe so logs surface the disappearance).
 */
export async function isPolicySafeToDelete(
  client: IlmRepoEsClient,
  policyName: string
): Promise<boolean> {
  const entry = await getIlmPolicy(client, policyName);
  if (!entry) return false;
  const inUse = entry.in_use_by ?? {};
  const indicesCount = inUse.indices?.length ?? 0;
  const dataStreamsCount = inUse.data_streams?.length ?? 0;
  const templatesCount = inUse.composable_templates?.length ?? 0;
  return indicesCount + dataStreamsCount + templatesCount === 0;
}

/**
 * Delete an ILM policy. Treats 404 as a no-op (idempotent) — the
 * other repos in this package use the same convention.
 *
 * Note: ES rejects DELETE if the policy is still referenced. Always
 * call `isPolicySafeToDelete` first.
 */
export async function deleteIlmPolicy(
  client: IlmRepoWriteEsClient,
  policyName: string
): Promise<void> {
  try {
    await client.ilm.deleteLifecycle({ name: policyName });
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }
}

/**
 * One orphan policy candidate as returned by `findOrphanedPolicies`.
 */
export interface OrphanedIlmPolicy {
  policy_name: string;
  referenced_repo: string;
}

/**
 * Outcome of `reapOrphanedIlmPolicies`. Callers translate these into
 * action-specific step records (rotate's `RotateStepRecord`, cleanup's
 * `CleanupStepRecord`, etc.).
 */
export interface ReapOrphanedPoliciesResult {
  deleted: OrphanedIlmPolicy[];
  /** Found, but still referenced by some index/data-stream/template. */
  skipped: OrphanedIlmPolicy[];
  /** Encountered an ES error during the safety check or delete. */
  failed: Array<OrphanedIlmPolicy & { error: string }>;
}

/**
 * ES client surface required to find + reap orphan deepfreeze policies.
 */
export type IlmReapEsClient = IlmRepoWriteEsClient & {
  snapshot: { getRepository: () => Promise<Record<string, unknown>> };
};

/**
 * Find every deepfreeze ILM policy whose `searchable_snapshot.snapshot_repository`
 * names a repo that no longer exists in ES's live snapshot registry.
 *
 * The base policy (`settings.ilm_policy_name` with no suffix) is never
 * a candidate — it's the immutable source-of-truth that Setup writes
 * and Rotate clones from. Only versioned variants are considered.
 *
 * Returns at most one entry per policy (first orphan reference wins).
 */
export async function findOrphanedPolicies(
  client: IlmReapEsClient,
  settings: { ilm_policy_name?: string | null; repo_name_prefix: string }
): Promise<OrphanedIlmPolicy[]> {
  if (!settings.ilm_policy_name) return [];

  const allPolicies = (await client.ilm.getLifecycle()) as Record<string, IlmPolicyEntry>;
  const liveRepos = await client.snapshot.getRepository();
  const existing = new Set(Object.keys(liveRepos));

  const orphans: OrphanedIlmPolicy[] = [];
  for (const [policyName, policyData] of Object.entries(allPolicies)) {
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
        break;
      }
    }
  }
  return orphans;
}

/**
 * Find orphan deepfreeze ILM policies, gate each on
 * `isPolicySafeToDelete`, and delete the safe ones.
 *
 * Used inline by Rotate after the per-repo archive loop (matches
 * Python's `_cleanup_orphaned_policies` running at the end of
 * `Rotate.do_action`) AND by Cleanup as part of its periodic sweep,
 * so a high-rotation cluster doesn't accumulate orphan policies
 * between Cleanup runs.
 *
 * Per-policy failures (404, in-use, ES error) are caught and folded
 * into the result — the function never throws.
 */
export async function reapOrphanedIlmPolicies(
  client: IlmReapEsClient,
  settings: { ilm_policy_name?: string | null; repo_name_prefix: string },
  log: { debug: (m: string) => void; warn: (m: string) => void }
): Promise<ReapOrphanedPoliciesResult> {
  const result: ReapOrphanedPoliciesResult = {
    deleted: [],
    skipped: [],
    failed: [],
  };
  let candidates: OrphanedIlmPolicy[];
  try {
    candidates = await findOrphanedPolicies(client, settings);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Orphan ILM policy scan failed: ${msg}`);
    return result;
  }

  for (const orphan of candidates) {
    try {
      const safe = await isPolicySafeToDelete(client, orphan.policy_name);
      if (!safe) {
        result.skipped.push(orphan);
        continue;
      }
      await deleteIlmPolicy(client, orphan.policy_name);
      result.deleted.push(orphan);
      log.debug(
        `Reaped orphan ILM policy ${orphan.policy_name} (referenced ${orphan.referenced_repo})`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Failed to reap orphan policy ${orphan.policy_name}: ${msg}`);
      result.failed.push({ ...orphan, error: msg });
    }
  }
  return result;
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { statusCode?: number; meta?: { statusCode?: number } };
  return e.statusCode === 404 || e.meta?.statusCode === 404;
}
