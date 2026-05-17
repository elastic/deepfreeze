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

/** Write methods needed for `createOrUpdateIlmPolicy`. */
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

/** Outcome of `createOrUpdateIlmPolicy`. */
export interface CreateOrUpdateIlmPolicyResult {
  action: 'created' | 'updated' | 'unchanged';
  policy_body: Record<string, unknown>;
}

/**
 * The default tiering strategy used when creating a fresh ILM policy
 * during Setup. Hot → Cold (30d) → Frozen (365d, searchable snapshot
 * to the new deepfreeze repo) → Delete (with delete_searchable_snapshot
 * forced to false so the underlying snapshot survives).
 *
 * Mirrors the same dictionary in
 *   packages/deepfreeze-core/deepfreeze_core/utilities.py
 *     — create_or_update_ilm_policy().
 */
export function defaultIlmPolicyBody(repoName: string): Record<string, unknown> {
  return {
    policy: {
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
    },
  };
}

/**
 * Either create a new ILM policy with the default deepfreeze tiering
 * strategy, or update an existing policy's `searchable_snapshot`
 * actions and `delete.delete_searchable_snapshot` flag to point at the
 * new repository.
 *
 * Mirrors `create_or_update_ilm_policy` in the Python utilities.
 *
 * Returns `'unchanged'` (with the unmodified body) if the policy exists
 * but has no `searchable_snapshot` actions to retarget — the caller
 * surfaces that to the user as a warning rather than an error.
 */
export async function createOrUpdateIlmPolicy(
  client: IlmRepoWriteEsClient,
  policyName: string,
  repoName: string
): Promise<CreateOrUpdateIlmPolicyResult> {
  const existing = await getIlmPolicy(client, policyName);

  if (existing === null) {
    const body = defaultIlmPolicyBody(repoName);
    await client.ilm.putLifecycle({ name: policyName, policy: body });
    return { action: 'created', policy_body: body };
  }

  // Deep clone so we can safely mutate.
  const updated = JSON.parse(JSON.stringify(existing)) as IlmPolicyEntry;
  const phases = updated.policy?.phases ?? {};
  let modified = false;

  for (const phaseConfig of Object.values(phases)) {
    const ss = phaseConfig.actions?.searchable_snapshot;
    if (ss && 'snapshot_repository' in ss) {
      if (ss.snapshot_repository !== repoName) {
        ss.snapshot_repository = repoName;
        modified = true;
      }
    }
  }

  const deletePhase = phases.delete as
    | { actions?: { delete?: { delete_searchable_snapshot?: boolean } } }
    | undefined;
  if (deletePhase?.actions?.delete) {
    if (deletePhase.actions.delete.delete_searchable_snapshot !== false) {
      deletePhase.actions.delete.delete_searchable_snapshot = false;
      modified = true;
    }
  }

  const body = { policy: updated.policy ?? {} };
  if (modified) {
    await client.ilm.putLifecycle({ name: policyName, policy: body });
    return { action: 'updated', policy_body: body };
  }

  return { action: 'unchanged', policy_body: body };
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { statusCode?: number; meta?: { statusCode?: number } };
  return e.statusCode === 404 || e.meta?.statusCode === 404;
}
