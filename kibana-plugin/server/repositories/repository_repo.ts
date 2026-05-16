/**
 * Repository (snapshot-repo metadata) access.
 *
 * Mirrors `get_all_repos` and `get_matching_repo_names` in
 *   packages/deepfreeze-core/deepfreeze_core/utilities.py
 */

import { DOCTYPE, STATUS_INDEX } from '../../common/constants';
import type { RepositoryDoc } from '../../common/schemas/repository';

export interface RepositoryRepoEsClient {
  search: (params: {
    index: string;
    query?: Record<string, unknown>;
    size?: number;
  }) => Promise<{
    hits: {
      hits: Array<{ _id: string; _source: Record<string, unknown> }>;
    };
  }>;
  snapshot: {
    get_repository: (params?: {
      name?: string;
    }) => Promise<Record<string, unknown>>;
  };
}

/**
 * Return every repository document stored in `deepfreeze-status`.
 *
 * Returns the on-disk shape (`RepositoryDoc`); the live `is_mounted`
 * state must be derived separately via `getMatchingRepoNames` (which
 * queries the cluster's snapshot repositories, not the deepfreeze
 * metadata index).
 */
export async function getAllRepos(
  client: RepositoryRepoEsClient
): Promise<RepositoryDoc[]> {
  const response = await client.search({
    index: STATUS_INDEX,
    query: { match: { doctype: DOCTYPE.repository } },
    size: 10000,
  });
  return response.hits.hits.map((hit) => hit._source as unknown as RepositoryDoc);
}

/**
 * Return the names of currently-registered ES snapshot repositories
 * whose name contains `repoNamePrefix`.
 *
 * Matches the Python implementation's use of `re.search(prefix)` — a
 * substring/regex match anywhere in the name, not just at the start.
 */
export async function getMatchingRepoNames(
  client: RepositoryRepoEsClient,
  repoNamePrefix: string
): Promise<string[]> {
  const repos = await client.snapshot.get_repository();
  const pattern = new RegExp(repoNamePrefix);
  return Object.keys(repos).filter((name) => pattern.test(name));
}
