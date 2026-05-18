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

/** Write methods needed for putting ILM policies (Setup and Rotate). */
export interface IlmRepoWriteEsClient extends IlmRepoEsClient {
  ilm: IlmRepoEsClient['ilm'] & {
    putLifecycle: (params: {
      name: string;
      policy: Record<string, unknown>;
    }) => Promise<unknown>;
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

interface IlmPolicyEntry {
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

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { statusCode?: number; meta?: { statusCode?: number } };
  return e.statusCode === 404 || e.meta?.statusCode === 404;
}
