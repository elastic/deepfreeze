/**
 * Status action — gather a snapshot of deepfreeze state for the
 * Overview / Repositories / Thaw Requests / Activity UI pages.
 *
 * Mirrors `Status.do_action` in
 *   packages/deepfreeze-core/deepfreeze_core/actions/status.py
 *   (read-only behaviour only; CLI display logic stays in Python).
 *
 * Per-repo storage-tier sampling mirrors Python's
 * `Status._get_repo_storage_tier`: list the first ~10 objects under
 * the repo's bucket/base_path, collect their storage classes, and
 * classify as Hot / Cool / Archive / Mixed / Empty / Unknown / N/A.
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
import type { StorageClient } from '../storage/types';

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
  /**
   * Optional storage client used to sample each repo's blob storage
   * classes and derive a `storage_tier` summary. When absent (or
   * sampling fails for an individual repo), the repo's `storage_tier`
   * stays unset — the UI shows "—" in that case.
   */
  storage?: StorageClient;
}

/**
 * Repo-storage-tier classification. Mirrors the keys returned by
 * Python's `Status._get_repo_storage_tier`.
 */
export type StorageTier =
  | 'Hot'
  | 'Cool'
  | 'Archive'
  | 'Mixed'
  | 'Empty'
  | 'Unknown'
  | 'N/A';

/** How many objects to sample per repo. Matches Python's hard-coded 10. */
const TIER_SAMPLE_SIZE = 10;

/**
 * Provider storage_class values → high-level deepfreeze tier. The
 * provider-specific names are listed exhaustively rather than via
 * regex so a new provider class doesn't silently fall through to a
 * default. Same mapping table as Python.
 */
const STORAGE_CLASS_TO_TIER: Record<string, StorageTier> = {
  // AWS
  STANDARD: 'Hot',
  REDUCED_REDUNDANCY: 'Hot',
  INTELLIGENT_TIERING: 'Hot',
  STANDARD_IA: 'Cool',
  ONEZONE_IA: 'Cool',
  GLACIER: 'Archive',
  GLACIER_IR: 'Cool',
  DEEP_ARCHIVE: 'Archive',
  // Azure (Blob)
  Hot: 'Hot',
  Cool: 'Cool',
  Archive: 'Archive',
  // GCS
  NEARLINE: 'Cool',
  COLDLINE: 'Archive',
  ARCHIVE: 'Archive',
  // Empty string from a provider that omits the field — treat as Hot
  // since a missing class on S3 is typically STANDARD in practice.
  '': 'Hot',
};

/**
 * Sample object storage classes for a single repo and classify the
 * result. Failures are swallowed and reported as 'N/A' — sampling is
 * a UI nice-to-have, not part of the status response's correctness
 * contract.
 */
async function sampleRepoStorageTier(
  storage: StorageClient,
  bucket: string,
  base_path: string
): Promise<StorageTier> {
  const path = base_path.replace(/^\/+|\/+$/g, '');
  const prefix = path ? `${path}/` : '';

  let objects;
  try {
    objects = await storage.listObjects(bucket, prefix);
  } catch {
    return 'N/A';
  }

  if (objects.length === 0) return 'Empty';

  const tiers = new Set<StorageTier>();
  for (const obj of objects.slice(0, TIER_SAMPLE_SIZE)) {
    const tier = STORAGE_CLASS_TO_TIER[obj.storage_class] ?? 'Unknown';
    tiers.add(tier);
  }

  if (tiers.size === 1) {
    return [...tiers][0];
  }
  return 'Mixed';
}

const NOOP_LOG = {
  debug: () => {},
  warn: () => {},
};

/**
 * Live-state repository view returned in `SystemStatus.repositories`.
 *
 * Same shape as the stored `RepositoryDoc` but `is_mounted` is the
 * **live** value derived from `snapshot.getRepository` rather than
 * whatever was last written into ES. `storage_tier` is the sampled
 * tier classification (Hot / Cool / Archive / Mixed / etc.) when a
 * storage client is supplied, otherwise undefined.
 */
export interface RepositorySummary extends RepositoryDoc {
  storage_tier?: StorageTier;
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

  // Storage-tier sampling. Best-effort per repo; failures bubble up
  // as 'N/A' on individual repos rather than aborting the response.
  // Runs in parallel (one listObjects per repo) — the list endpoint
  // is cheap and bounded by the deepfreeze repo count.
  const repositoriesWithTier = options.storage
    ? await annotateStorageTiers(repositories, options.storage, log)
    : repositories;

  return {
    cluster,
    settings,
    repositories: repositoriesWithTier,
    thaw_requests: thawRequests,
    buckets: [], // Phase 4 follow-up: per-bucket info if anything beyond per-repo tier is wanted
    ilm_policies: ilmPolicies,
    initialized,
    errors,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Run the storage-tier sampler against every repo and return a fresh
 * array of summaries with `storage_tier` populated.
 */
async function annotateStorageTiers(
  repositories: RepositorySummary[],
  storage: StorageClient,
  log: NonNullable<RunStatusOptions['log']>
): Promise<RepositorySummary[]> {
  const samples = await Promise.all(
    repositories.map(async (repo) => {
      try {
        return await sampleRepoStorageTier(storage, repo.bucket, repo.base_path);
      } catch (err) {
        log.warn(
          `Storage-tier sample failed for ${repo.name}: ${stringifyError(err)}`
        );
        return 'N/A' as StorageTier;
      }
    })
  );
  return repositories.map((repo, i) => ({ ...repo, storage_tier: samples[i] }));
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
