/**
 * Snapshot-repository introspection and creation against the ES API.
 *
 * Mirrors the pieces of `packages/deepfreeze-core/deepfreeze_core/utilities.py`
 * that drive `Setup`: enumerating existing snapshot repos for
 * precondition checks and for the wizard's bucket dropdown, and
 * creating the new repo via `PUT _snapshot/{name}` with `verify=true`.
 *
 * The Phase 2 contract is "bucket must pre-exist" — the deepfreeze
 * plugin never creates buckets. The wizard surfaces buckets already in
 * use by existing snapshot repositories so the user can pick one
 * (see project_phase2_setup_design.md).
 */

import type { Provider } from '../../common/constants';

/** Live snapshot-repo config as returned by `GET _snapshot/_all`. */
export interface SnapshotRepositoryConfig {
  /** Repository name (the key of the `_snapshot/_all` map). */
  name: string;
  /** ES repository type: `s3`, `azure`, `gcs`, `fs`, etc. */
  type: string;
  /** Cloud bucket (s3/gcs) or container (azure). Empty for non-cloud types. */
  bucket: string;
  /** Path within the bucket. Empty when the repo writes to the bucket root. */
  base_path: string;
}

/**
 * Minimal structural interface for the snapshot-repo helpers below.
 */
export interface SnapshotRepoEsClient {
  snapshot: {
    getRepository: (params?: { name?: string }) => Promise<Record<string, unknown>>;
    createRepository: (params: {
      name: string;
      repository: { type: string; settings: Record<string, unknown> };
      verify?: boolean;
    }) => Promise<unknown>;
    deleteRepository: (params: { name: string }) => Promise<unknown>;
  };
}

interface RawRepoEntry {
  type?: string;
  settings?: Record<string, unknown>;
}

/**
 * Return every snapshot repository known to the cluster, normalized to
 * the `SnapshotRepositoryConfig` shape. Non-cloud types (e.g. `fs`)
 * are included with empty `bucket`/`base_path` so callers that filter
 * on bucket can simply drop them.
 */
export async function getSnapshotRepositoryConfigs(
  client: SnapshotRepoEsClient
): Promise<SnapshotRepositoryConfig[]> {
  const repos = (await client.snapshot.getRepository()) as Record<string, RawRepoEntry>;
  return Object.entries(repos).map(([name, raw]) => {
    const settings = raw.settings ?? {};
    const type = raw.type ?? 'unknown';
    // s3 / gcs use `bucket`; azure uses `container`.
    const bucket = String(settings.bucket ?? settings.container ?? '');
    const base_path = String(settings.base_path ?? '');
    return { name, type, bucket, base_path };
  });
}

/**
 * Return the unique set of buckets currently used by any cloud-backed
 * snapshot repository in the cluster. Empty bucket names (e.g. `fs`
 * repos) are dropped. Sorted for stable UI display.
 */
export async function getBucketsInUse(client: SnapshotRepoEsClient): Promise<string[]> {
  const configs = await getSnapshotRepositoryConfigs(client);
  const seen = new Set<string>();
  for (const cfg of configs) {
    if (cfg.bucket) seen.add(cfg.bucket);
  }
  return Array.from(seen).sort();
}

/**
 * True if any existing snapshot repository already writes to
 * `bucket` + `base_path`. Used as a precondition to prevent two
 * repos colliding on the same storage location.
 */
export async function isBucketBasePathInUse(
  client: SnapshotRepoEsClient,
  bucket: string,
  base_path: string
): Promise<boolean> {
  const configs = await getSnapshotRepositoryConfigs(client);
  return configs.some((c) => c.bucket === bucket && c.base_path === base_path);
}

/**
 * Names of any existing snapshot repositories whose name starts with
 * `repoNamePrefix`. Used by Setup's "no pre-existing deepfreeze repos"
 * precondition.
 */
export async function getReposMatchingPrefix(
  client: SnapshotRepoEsClient,
  repoNamePrefix: string
): Promise<string[]> {
  const configs = await getSnapshotRepositoryConfigs(client);
  return configs.filter((c) => c.name.startsWith(repoNamePrefix)).map((c) => c.name);
}

export interface CreateSnapshotRepositoryParams {
  /** Name of the new repository to register. */
  name: string;
  provider: Provider;
  bucket: string;
  base_path: string;
  /** AWS only; ignored for azure/gcp. */
  canned_acl?: string;
  /** AWS only; ignored for azure/gcp. */
  storage_class?: string;
}

/**
 * Register a new snapshot repository in ES. Calls
 * `PUT _snapshot/{name}` with `verify=true`, so the call fails fast if
 * the bucket isn't reachable with the cluster's configured credentials.
 *
 * Mirrors `create_repo` in
 *   packages/deepfreeze-core/deepfreeze_core/utilities.py
 * but does *not* save the corresponding `RepositoryDoc` to the status
 * index — `runSetup` does that after the call returns successfully.
 */
export async function createSnapshotRepository(
  client: SnapshotRepoEsClient,
  params: CreateSnapshotRepositoryParams
): Promise<void> {
  const { name, provider, bucket, base_path } = params;

  let type: string;
  let settings: Record<string, unknown>;

  if (provider === 'azure') {
    type = 'azure';
    settings = { container: bucket, base_path };
  } else if (provider === 'gcp') {
    type = 'gcs';
    settings = { bucket, base_path };
  } else {
    type = 's3';
    settings = {
      bucket,
      base_path,
      canned_acl: params.canned_acl ?? 'private',
      storage_class: params.storage_class ?? 'standard',
    };
  }

  await client.snapshot.createRepository({
    name,
    repository: { type, settings },
    verify: true,
  });
}

/**
 * Remove a snapshot repository from ES. Returns 404 cleanly (the
 * repository was already gone, no-op).
 *
 * ES rejects the request if any searchable-snapshot indices still
 * reference the repo. Rotate catches that error and surfaces it as a
 * per-repo warning rather than aborting the whole run.
 */
export async function deleteSnapshotRepository(
  client: SnapshotRepoEsClient,
  name: string
): Promise<void> {
  try {
    await client.snapshot.deleteRepository({ name });
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { statusCode?: number; meta?: { statusCode?: number } };
  return e.statusCode === 404 || e.meta?.statusCode === 404;
}
