/**
 * Searchable-snapshot mount helpers used by the final step of Thaw.
 *
 * Once all S3 objects are warm and the snapshot repo is re-registered
 * with ES, we still have to mount the snapshots themselves as
 * searchable_snapshot indices — otherwise the repo is available but
 * its data is invisible. This file owns that second-half of mount:
 *   - listing the indices that exist in a repo's snapshots,
 *   - mounting them via `searchable_snapshots.mount`,
 *   - creating + assigning the `{repo}-thawed` ILM policy,
 *   - and stripping the `fm-clone-` prefix that ILM's force-merge
 *     action prepends to its private clones (we want the mounted
 *     index to use the original name).
 *
 * Mirrors `mount_snapshot_index`, `create_thawed_ilm_policy`,
 * `find_snapshots_for_index`, and `get_all_indices_in_repo` in
 *   packages/deepfreeze-core/deepfreeze_core/utilities.py
 *
 * Date-range overlap pruning and the orchestration that loops every
 * repo live in `server/actions/thaw.ts` — this file is just the
 * primitive operations.
 */

/**
 * Minimal ES client surface for the helpers below. Compose with
 * `DateRangeEsClient` from `repository_date_range.ts` in the
 * orchestrator if you also need `@timestamp` aggregation.
 */
export interface SearchableSnapshotEsClient {
  snapshot: {
    get: (params: { repository: string; snapshot: string }) => Promise<{
      snapshots?: Array<{ snapshot?: string; indices?: string[] }>;
    }>;
  };
  searchableSnapshots: {
    mount: (params: {
      repository: string;
      snapshot: string;
      body: {
        index: string;
        renamed_index?: string;
      };
    }) => Promise<unknown>;
  };
  indices: {
    exists: (params: { index: string }) => Promise<boolean> | boolean;
    delete: (params: { index: string }) => Promise<unknown>;
    putSettings: (params: {
      index: string;
      body: Record<string, unknown>;
    }) => Promise<unknown>;
  };
  ilm: {
    getLifecycle: (params: { name?: string }) => Promise<Record<string, unknown>>;
    putLifecycle: (params: {
      name: string;
      policy: Record<string, unknown>;
    }) => Promise<unknown>;
    removeLifecycle: (params: { index: string }) => Promise<unknown>;
  };
}

/**
 * Return the union of every index name referenced by any snapshot in
 * `repo`. Mirrors Python's `get_all_indices_in_repo`.
 *
 * Returns `[]` when the repo has no snapshots — callers shouldn't have
 * to special-case empty.
 */
export async function getAllIndicesInRepo(
  client: SearchableSnapshotEsClient,
  repo: string
): Promise<string[]> {
  const resp = await client.snapshot.get({ repository: repo, snapshot: '_all' });
  const seen = new Set<string>();
  for (const snap of resp.snapshots ?? []) {
    for (const idx of snap.indices ?? []) {
      seen.add(idx);
    }
  }
  return Array.from(seen);
}

/**
 * Find the most recent snapshot in `repo` containing `index`. Returns
 * `null` if no snapshot has it.
 *
 * "Most recent" here is the last entry in the snapshot list returned by
 * ES, which orders by `start_time` ascending. Mirrors Python's
 * `find_snapshots_for_index` followed by `snapshots[-1]`.
 */
export async function findLatestSnapshotForIndex(
  client: SearchableSnapshotEsClient,
  repo: string,
  index: string
): Promise<string | null> {
  const resp = await client.snapshot.get({ repository: repo, snapshot: '_all' });
  let latest: string | null = null;
  for (const snap of resp.snapshots ?? []) {
    if (!snap.snapshot || !snap.indices) continue;
    if (snap.indices.includes(index)) {
      latest = snap.snapshot;
    }
  }
  return latest;
}

/**
 * Strip ILM force-merge's `fm-clone-<random>-` prefix from a snapshot
 * index name so the mounted searchable_snapshot index keeps its
 * original identity. Returns the input unchanged when no prefix is
 * present. Pattern: `fm-clone-<random>-<original>` → `<original>`.
 *
 * Mirrors the Python inline logic in `mount_snapshot_index`.
 */
export function stripFmClonePrefix(indexName: string): string {
  if (!indexName.startsWith('fm-clone-')) return indexName;
  // ['fm', 'clone', '<random>', '<original>'] — the original-name
  // segment can itself contain hyphens, but `split('-', 4)` with limit
  // 4 in TS doesn't behave the same as Python; do it manually.
  const segments = indexName.split('-');
  if (segments.length < 4) return indexName;
  return segments.slice(3).join('-');
}

/**
 * Idempotently create the `{repo}-thawed` ILM policy. Returns the
 * policy name in both the "already existed" and "just created" cases.
 *
 * The policy has a single Delete phase at min_age 29d with
 * `delete_searchable_snapshot: true`. This matches the 30-day S3
 * restore-window ceiling: ES auto-cleans the mounted index one day
 * before S3 would auto-evict the restored copy, so we never leave an
 * index pointing at a re-frozen object.
 *
 * Mirrors `create_thawed_ilm_policy` in Python utilities.py:1019.
 */
export async function ensureThawedIlmPolicy(
  client: SearchableSnapshotEsClient,
  repo: string
): Promise<string> {
  const policyName = `${repo}-thawed`;
  try {
    await client.ilm.getLifecycle({ name: policyName });
    // Already exists — no-op.
    return policyName;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await client.ilm.putLifecycle({
    name: policyName,
    policy: {
      phases: {
        delete: {
          min_age: '29d',
          actions: {
            delete: {
              delete_searchable_snapshot: true,
            },
          },
        },
      },
    },
  });
  return policyName;
}

/**
 * Assign `policy` to `index`, removing whatever ILM policy was bound
 * before. Tolerant of "no current policy" (the remove step throws,
 * which we swallow) — fresh-mount indices haven't had a policy yet.
 */
export async function assignIlmPolicy(
  client: SearchableSnapshotEsClient,
  index: string,
  policy: string
): Promise<void> {
  try {
    await client.ilm.removeLifecycle({ index });
  } catch {
    // No current policy attached — proceed.
  }
  await client.indices.putSettings({
    index,
    body: { 'index.lifecycle.name': policy },
  });
}

/**
 * Mount one snapshot index as a searchable_snapshot. Returns true on
 * mount (or skip-because-already-mounted), false on failure.
 *
 * Behavior matrix:
 *   - `indices.exists(mountedName)` is true → no-op (caller may still
 *     want to assign the ILM policy; that's a separate step). Returns
 *     true so the caller treats this as success.
 *   - else → call `searchable_snapshots.mount` with `index` = the name
 *     inside the snapshot (with any `fm-clone-` prefix) and
 *     `renamed_index` = the public-facing name (prefix stripped). On
 *     success returns true; on throw, returns false.
 *
 * Failures are caught + reported via the return value rather than
 * thrown — the orchestrator records per-index failures into its
 * `failed[]` counter without aborting the batch.
 */
export async function mountSnapshotIndex(
  client: SearchableSnapshotEsClient,
  params: {
    repo: string;
    snapshot: string;
    indexNameInSnapshot: string;
    mountedName: string;
  },
  log: { debug: (m: string) => void; warn: (m: string) => void }
): Promise<{ mounted: boolean; alreadyMounted: boolean }> {
  const { repo, snapshot, indexNameInSnapshot, mountedName } = params;
  if (await client.indices.exists({ index: mountedName })) {
    log.debug(`searchable_snapshot: ${mountedName} already mounted, skipping`);
    return { mounted: true, alreadyMounted: true };
  }
  try {
    await client.searchableSnapshots.mount({
      repository: repo,
      snapshot,
      body: {
        index: indexNameInSnapshot,
        // Only specify renamed_index when it differs from the source —
        // ES is happy either way, but avoiding the field when it's a
        // no-op keeps audit/log output cleaner.
        ...(mountedName !== indexNameInSnapshot ? { renamed_index: mountedName } : {}),
      },
    });
    log.debug(`searchable_snapshot: mounted ${repo}/${snapshot} → ${mountedName}`);
    return { mounted: true, alreadyMounted: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`searchable_snapshot: failed to mount ${mountedName}: ${msg}`);
    return { mounted: false, alreadyMounted: false };
  }
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { statusCode?: number; meta?: { statusCode?: number } };
  return e.statusCode === 404 || e.meta?.statusCode === 404;
}
