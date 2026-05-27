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
    getDataStream: (params: { name: string }) => Promise<unknown>;
    modifyDataStream: (params: {
      body: {
        actions: Array<{
          add_backing_index?: { data_stream: string; index: string };
          remove_backing_index?: { data_stream: string; index: string };
        }>;
      };
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
 * Policy shape:
 *   - **Cold phase at min_age 0** — the mounted searchable_snapshot
 *     enters the cold tier immediately so the local cache lands on
 *     cold-tier nodes. The set_priority action is just a placeholder
 *     so ILM has something to execute; the tier-preference update
 *     happens automatically on phase entry.
 *   - **Delete phase at min_age 29d** — one day before the S3
 *     restore-window ceiling (30 days max). After that the mount
 *     can no longer read its data, so ILM tears it down.
 *   - **`delete_searchable_snapshot: false`** — project-wide rule:
 *     deepfreeze ILM never deletes the underlying snapshot. Snapshot
 *     deletion is a deliberate operator action (Refreeze, Rotate's
 *     archive step, Cleanup), not an automatic ILM consequence.
 *     Diverges from Python's `create_thawed_ilm_policy` here on
 *     purpose — Python uses `True`, deepfreeze's Kibana plugin uses
 *     `False`.
 */
export async function ensureThawedIlmPolicy(
  client: SearchableSnapshotEsClient,
  repo: string
): Promise<string> {
  const policyName = `${repo}-thawed`;
  try {
    await client.ilm.getLifecycle({ name: policyName });
    return policyName;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await client.ilm.putLifecycle({
    name: policyName,
    policy: {
      phases: {
        cold: {
          min_age: '0ms',
          actions: {
            set_priority: { priority: 0 },
          },
        },
        delete: {
          min_age: '29d',
          actions: {
            delete: {
              delete_searchable_snapshot: false,
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

/**
 * If `indexName` looks like a data-stream backing index, extract the
 * data-stream name from the conventional `.ds-<ds-name>-<YYYY.MM.DD>-<NNNNNN>`
 * pattern. Returns `null` when the name doesn't match. Pure function;
 * no ES round-trip.
 *
 * Mirrors the name-parsing branch of Python's
 * `get_index_datastream_name` (`utilities.py:2252`). Python also has a
 * settings-lookup fallback path; we skip it because every mounted
 * data-stream backing index we care about reaches us with the
 * canonical `.ds-` name (fm-clone prefix stripped by `mountSnapshotIndex`).
 */
export function parseDataStreamFromIndexName(indexName: string): string | null {
  if (!indexName.startsWith('.ds-')) return null;
  const remaining = indexName.slice(4);
  // Trailing two segments are date (YYYY.MM.DD) and rollover sequence
  // (NNNNNN). Everything before them is the data-stream name, which
  // may itself contain hyphens. `rsplit(remaining, '-', 2)` in Python
  // terms — we slice manually since JS's `split` can't limit from the
  // right.
  const lastHyphen = remaining.lastIndexOf('-');
  if (lastHyphen <= 0) return null;
  const beforeSeq = remaining.slice(0, lastHyphen);
  const penultimateHyphen = beforeSeq.lastIndexOf('-');
  if (penultimateHyphen <= 0) return null;
  return beforeSeq.slice(0, penultimateHyphen);
}

/**
 * Re-add a backing index to its data stream after thaw-time mount.
 * Returns true on success, false on any failure (best-effort — the
 * caller logs but doesn't abort the thaw on a failed re-add).
 *
 * Verifies the data stream exists first; if it doesn't, returns false
 * without attempting the modify_data_stream call. A thawed backing
 * index whose data stream has been deleted has no home to return to.
 *
 * Mirrors Python's `add_index_to_datastream` (`utilities.py:2307`).
 */
export async function addIndexToDatastream(
  client: SearchableSnapshotEsClient,
  datastreamName: string,
  indexName: string,
  log: { debug: (m: string) => void; warn: (m: string) => void }
): Promise<boolean> {
  try {
    await client.indices.getDataStream({ name: datastreamName });
  } catch (err) {
    if (isNotFound(err)) {
      log.warn(
        `Cannot re-add ${indexName} to ${datastreamName}: data stream does not exist`
      );
      return false;
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Data stream lookup failed for ${datastreamName}: ${msg}`);
    return false;
  }
  try {
    await client.indices.modifyDataStream({
      body: {
        actions: [
          {
            add_backing_index: {
              data_stream: datastreamName,
              index: indexName,
            },
          },
        ],
      },
    });
    log.debug(`Re-added ${indexName} to data stream ${datastreamName}`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Failed to re-add ${indexName} to ${datastreamName}: ${msg}`);
    return false;
  }
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { statusCode?: number; meta?: { statusCode?: number } };
  return e.statusCode === 404 || e.meta?.statusCode === 404;
}
