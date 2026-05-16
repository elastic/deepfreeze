/**
 * Status action — gather a snapshot of deepfreeze state for the
 * Overview / Repositories / Thaw Requests / Activity UI pages.
 *
 * Mirrors `Status.do_action` in
 *   packages/deepfreeze-core/deepfreeze_core/actions/status.py
 *   (read-only behaviour only; CLI display logic and the per-repo
 *   storage-tier sampling are deferred to Phase 4 when the storage
 *   adapters land).
 *
 * Contract: returns a fully-shaped `SystemStatus`. Never throws for
 * "expected" missing-state errors (no status index, no settings) —
 * instead the response has `initialized: false` and the error is
 * recorded in `errors[]`. Unexpected errors propagate.
 */

import type { SystemStatus, ClusterHealth } from '../../common/types/status';
import type { RepositoryDoc } from '../../common/schemas/repository';
import type { ThawRequestDoc } from '../../common/schemas/thaw_request';
import type { SettingsDoc } from '../../common/schemas/settings';
import type { ServiceError } from '../../common/types/errors';
import { MissingIndexError, MissingSettingsError } from '../errors';
import {
  getSettings,
  type SettingsRepoEsClient,
} from '../repositories/settings_repo';
import {
  getAllRepos,
  getMatchingRepoNames,
  type RepositoryRepoEsClient,
} from '../repositories/repository_repo';
import {
  listThawRequests,
  type ThawRequestRepoEsClient,
} from '../repositories/thaw_request_repo';
import {
  getDeepfreezeIlmPolicies,
  type DeepfreezeIlmPolicyInfo,
  type IlmRepoEsClient,
} from '../repositories/ilm_repo';

/** ES client surface required by `runStatus`. */
export interface StatusActionEsClient
  extends SettingsRepoEsClient,
    RepositoryRepoEsClient,
    ThawRequestRepoEsClient,
    IlmRepoEsClient {
  cluster: {
    health: () => Promise<{
      cluster_name?: string;
      status?: 'green' | 'yellow' | 'red';
      number_of_nodes?: number;
    }>;
  };
  info: () => Promise<{ version?: { number?: string } }>;
}

export interface RunStatusOptions {
  /** Optional sink for warnings about non-fatal sub-fetch failures. */
  log?: {
    debug: (msg: string) => void;
    warn: (msg: string) => void;
  };
}

const NOOP_LOG = {
  debug: () => {},
  warn: () => {},
};

/**
 * Live-state repository view returned in `SystemStatus.repositories`.
 *
 * Same shape as the stored `RepositoryDoc` but `is_mounted` is the
 * **live** value derived from `snapshot.get_repository` rather than
 * whatever was last written into ES. Phase 4 will add `storage_tier`.
 */
export interface RepositorySummary extends RepositoryDoc {
  storage_tier?: string;
}

/** Public return shape — equal to SystemStatus with our refined repo type. */
export type StatusResult = Omit<SystemStatus, 'repositories' | 'ilm_policies'> & {
  repositories: RepositorySummary[];
  ilm_policies: DeepfreezeIlmPolicyInfo[];
};

export async function runStatus(
  client: StatusActionEsClient,
  options: RunStatusOptions = {}
): Promise<StatusResult> {
  const log = options.log ?? NOOP_LOG;
  const errors: ServiceError[] = [];

  const cluster = await fetchClusterHealth(client, log, errors);

  let settings: SettingsDoc | null = null;
  let initialized = true;

  try {
    settings = await getSettings(client);
    if (settings === null) {
      throw new MissingSettingsError('Settings document not found in status index');
    }
  } catch (err) {
    if (err instanceof MissingIndexError) {
      log.debug('deepfreeze status index missing — reporting uninitialized');
      errors.push({
        code: 'MISSING_INDEX',
        message: err.message,
        severity: 'warning',
        remediation: "Run 'Setup' to initialize deepfreeze in this cluster.",
      });
      return emptyResult(cluster, errors);
    }
    if (err instanceof MissingSettingsError) {
      log.debug('deepfreeze settings document missing — reporting uninitialized');
      errors.push({
        code: 'MISSING_SETTINGS',
        message: err.message,
        severity: 'warning',
        remediation: "Run 'Setup' to create the initial configuration document.",
      });
      return emptyResult(cluster, errors);
    }
    throw err;
  }

  // From here on we have a usable settings doc — initialized = true.
  const [repositories, thawRequests, ilmPolicies] = await Promise.all([
    fetchRepositories(client, settings.repo_name_prefix, log, errors),
    fetchThawRequests(client, log, errors),
    fetchIlmPolicies(client, settings.repo_name_prefix, log, errors),
  ]);

  return {
    cluster,
    settings,
    repositories,
    thaw_requests: thawRequests,
    buckets: [], // Phase 4: storage client integration
    ilm_policies: ilmPolicies,
    initialized,
    errors,
    timestamp: new Date().toISOString(),
  };
}

async function fetchClusterHealth(
  client: StatusActionEsClient,
  log: NonNullable<RunStatusOptions['log']>,
  errors: ServiceError[]
): Promise<ClusterHealth> {
  try {
    const [health, info] = await Promise.all([client.cluster.health(), client.info()]);
    return {
      name: health.cluster_name ?? '',
      status: health.status ?? 'unknown',
      node_count: health.number_of_nodes ?? 0,
      version: info.version?.number ?? '',
    };
  } catch (err) {
    log.warn(`Failed to fetch cluster health: ${stringifyError(err)}`);
    errors.push({
      code: 'INTERNAL_ERROR',
      message: `Cluster health fetch failed: ${stringifyError(err)}`,
      severity: 'warning',
    });
    return { name: '', status: 'unknown', node_count: 0, version: '' };
  }
}

async function fetchRepositories(
  client: StatusActionEsClient,
  repoNamePrefix: string,
  log: NonNullable<RunStatusOptions['log']>,
  errors: ServiceError[]
): Promise<RepositorySummary[]> {
  try {
    const [allRepos, mountedNames] = await Promise.all([
      getAllRepos(client),
      getMatchingRepoNames(client, repoNamePrefix),
    ]);
    const mountedSet = new Set(mountedNames);
    return allRepos.map((repo) => ({
      ...repo,
      // Override the stored is_mounted with the live ES snapshot-repo state.
      is_mounted: mountedSet.has(repo.name),
    }));
  } catch (err) {
    log.warn(`Failed to fetch repositories: ${stringifyError(err)}`);
    errors.push({
      code: 'INTERNAL_ERROR',
      message: `Repository fetch failed: ${stringifyError(err)}`,
      severity: 'warning',
    });
    return [];
  }
}

async function fetchThawRequests(
  client: StatusActionEsClient,
  log: NonNullable<RunStatusOptions['log']>,
  errors: ServiceError[]
): Promise<ThawRequestDoc[]> {
  try {
    return await listThawRequests(client);
  } catch (err) {
    log.warn(`Failed to fetch thaw requests: ${stringifyError(err)}`);
    errors.push({
      code: 'INTERNAL_ERROR',
      message: `Thaw-request fetch failed: ${stringifyError(err)}`,
      severity: 'warning',
    });
    return [];
  }
}

async function fetchIlmPolicies(
  client: StatusActionEsClient,
  repoNamePrefix: string,
  log: NonNullable<RunStatusOptions['log']>,
  errors: ServiceError[]
): Promise<DeepfreezeIlmPolicyInfo[]> {
  try {
    return await getDeepfreezeIlmPolicies(client, repoNamePrefix);
  } catch (err) {
    log.warn(`Failed to fetch ILM policies: ${stringifyError(err)}`);
    errors.push({
      code: 'INTERNAL_ERROR',
      message: `ILM-policy fetch failed: ${stringifyError(err)}`,
      severity: 'warning',
    });
    return [];
  }
}

function emptyResult(cluster: ClusterHealth, errors: ServiceError[]): StatusResult {
  return {
    cluster,
    settings: null,
    repositories: [],
    thaw_requests: [],
    buckets: [],
    ilm_policies: [],
    initialized: false,
    errors,
    timestamp: new Date().toISOString(),
  };
}

function stringifyError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
