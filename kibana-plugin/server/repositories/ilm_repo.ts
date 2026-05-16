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
    get_lifecycle: () => Promise<Record<string, unknown>>;
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
  const allPolicies = (await client.ilm.get_lifecycle()) as Record<
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
