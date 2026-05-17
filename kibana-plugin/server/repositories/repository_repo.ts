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
    getRepository: (params?: {
      name?: string;
    }) => Promise<Record<string, unknown>>;
  };
}

/** Write surface for saving Repository docs to the status index. */
export interface RepositoryRepoWriteEsClient extends RepositoryRepoEsClient {
  index: (params: {
    index: string;
    id: string;
    document: Record<string, unknown>;
    refresh?: 'wait_for' | 'true' | 'false' | boolean;
  }) => Promise<unknown>;
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
  const repos = await client.snapshot.getRepository();
  const pattern = new RegExp(repoNamePrefix);
  return Object.keys(repos).filter((name) => pattern.test(name));
}

/**
 * Persist a Repository document to the status index. The repo `name`
 * is used as the document ID so subsequent saves upsert in place.
 *
 * Mirrors the `client.index(...)` call inside `create_repo` in the
 * Python utilities.
 */
export async function saveRepositoryDoc(
  client: RepositoryRepoWriteEsClient,
  repo: RepositoryDoc
): Promise<void> {
  await client.index({
    index: STATUS_INDEX,
    id: repo.name,
    document: { ...repo, doctype: 'repository' },
    refresh: 'wait_for',
  });
}
