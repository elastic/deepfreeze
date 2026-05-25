/**
 * Repository date-range computation and persistence.
 *
 * Shared by RepairMetadata and Rotate (both invoke
 * `updateRepositoryDateRange` to capture min/max `@timestamp` from a
 * mounted repo's indices and persist them onto its RepositoryDoc).
 *
 * Mirrors `update_repository_date_range` + supporting helpers in
 *   packages/deepfreeze-core/deepfreeze_core/utilities.py
 *
 * The merge rule is "only extend, never shrink": if the repo already
 * has a date range, the persisted result is the union of the existing
 * range and the freshly-queried range. This keeps callers from
 * accidentally narrowing the recorded window if some indices were
 * deleted between calls.
 */

import type { RepositoryDoc } from '../../common/schemas/repository';
import { saveRepositoryDoc, type RepositoryRepoWriteEsClient } from './repository_repo';

/**
 * ES methods needed by the date-range update flow: list snapshots in
 * a repo, check whether an index exists (to resolve mount-name
 * variants), and run a min/max aggregation over `@timestamp`.
 */
export interface DateRangeEsClient {
  snapshot: {
    get: (params: {
      repository: string;
      snapshot: string;
    }) => Promise<{
      snapshots?: Array<{ snapshot?: string; indices?: string[] }>;
    }>;
  };
  indices: {
    exists: (params: { index: string }) => Promise<boolean> | boolean;
  };
  search: (params: {
    index: string;
    size?: number;
    query?: Record<string, unknown>;
    aggs?: Record<string, unknown>;
    allow_partial_search_results?: boolean;
  }) => Promise<{
    hits?: { hits: Array<{ _id: string; _source: Record<string, unknown> }> };
    aggregations?: {
      earliest?: { value_as_string?: string };
      latest?: { value_as_string?: string };
    };
  }>;
}

/**
 * Outcome of running `updateRepositoryDateRange` on a single repo.
 *
 * Used by both RepairMetadata (reports per-repo) and Rotate (logs per
 * step). Callers without an outcome entry either already had both
 * `start` and `end` set or weren't mounted (we can't query
 * `@timestamp` on an unmounted searchable snapshot).
 */
export interface DateRangeOutcome {
  repo: string;
  /** True if start/end was persisted to the status index. */
  changed: boolean;
  /** Final (post-merge) date range — same as previous when unchanged. */
  start: string | null;
  end: string | null;
  /** Pre-update values, for UI diffs. */
  previous_start: string | null;
  previous_end: string | null;
  /** Set when we deliberately didn't run (e.g. dry-run, no @timestamp). */
  skipped_reason?: string;
  /** Set when an ES call threw. */
  error?: string;
}

/**
 * Every index name that appears in any snapshot of this repo. Returns
 * a deduped list. A missing or empty repo returns `[]`.
 */
async function getAllIndicesInRepo(
  client: DateRangeEsClient,
  repository: string
): Promise<string[]> {
  try {
    const resp = await client.snapshot.get({ repository, snapshot: '_all' });
    const seen = new Set<string>();
    for (const snap of resp.snapshots ?? []) {
      for (const idx of snap.indices ?? []) seen.add(idx);
    }
    return Array.from(seen);
  } catch {
    return [];
  }
}

/**
 * Resolve which on-disk indices correspond to the snapshot's index
 * names. ILM force-merge creates snapshots with `fm-clone-<rand>-`
 * prefixed names, but the actual mounted index uses the original.
 * Mounted searchable snapshots may also be reachable under
 * `partial-<name>` or `restored-<name>`.
 *
 * Mirrors the lookup ladder in Python's
 *   update_repository_date_range -> mounted_indices loop.
 */
async function resolveMountedIndexNames(
  client: DateRangeEsClient,
  snapshotIndices: string[]
): Promise<string[]> {
  const found: string[] = [];
  for (const original of snapshotIndices) {
    // Strip fm-clone-<random>- prefix when present.
    let idx = original;
    if (idx.startsWith('fm-clone-')) {
      const parts = idx.split('-');
      // ['fm', 'clone', '<rand>', ...rest]
      if (parts.length >= 4) {
        idx = parts.slice(3).join('-');
      }
    }
    const candidates = [idx, `partial-${idx}`, `restored-${idx}`];
    for (const candidate of candidates) {
      if (await client.indices.exists({ index: candidate })) {
        found.push(candidate);
        break;
      }
    }
  }
  return found;
}

/**
 * Aggregate min/max `@timestamp` over the given indices. Returns ISO
 * strings, or null/null if the aggregation produces no values
 * (no @timestamp field, no documents).
 *
 * Exported for reuse by Thaw's index-mount date-overlap pruning step
 * — same aggregation shape as repo-level date capture.
 */
export async function getTimestampRange(
  client: DateRangeEsClient,
  indices: string[]
): Promise<{ earliest: string | null; latest: string | null }> {
  if (indices.length === 0) return { earliest: null, latest: null };
  try {
    const resp = await client.search({
      index: indices.join(','),
      size: 0,
      aggs: {
        earliest: { min: { field: '@timestamp' } },
        latest: { max: { field: '@timestamp' } },
      },
      allow_partial_search_results: true,
    });
    const earliest = resp.aggregations?.earliest?.value_as_string ?? null;
    const latest = resp.aggregations?.latest?.value_as_string ?? null;
    return { earliest, latest };
  } catch {
    return { earliest: null, latest: null };
  }
}

/**
 * Populate (or extend) a repo's `start`/`end` by querying its mounted
 * indices' `@timestamp` range, then persist the updated RepositoryDoc.
 *
 * Mirrors `update_repository_date_range` in
 *   packages/deepfreeze-core/deepfreeze_core/utilities.py
 * with one deliberate behavior alignment: the merge rule is
 * "only extend, never shrink" — if existing dates are present, the
 * final range is `min(existing.start, queried.earliest) ..
 * max(existing.end, queried.latest)`.
 *
 * Returns an outcome record describing whether/what changed. Safe to
 * call repeatedly; idempotent when no new indices are present.
 */
export async function updateRepositoryDateRange(
  client: DateRangeEsClient & RepositoryRepoWriteEsClient,
  repo: RepositoryDoc
): Promise<DateRangeOutcome> {
  const outcome: DateRangeOutcome = {
    repo: repo.name,
    changed: false,
    start: repo.start,
    end: repo.end,
    previous_start: repo.start,
    previous_end: repo.end,
  };

  // Only mounted repos can be queried for @timestamp — for unmounted
  // searchable snapshots there are no live indices to aggregate over.
  if (!repo.is_mounted) {
    outcome.skipped_reason = 'repo not mounted; @timestamp unavailable';
    return outcome;
  }

  try {
    const snapshotIndices = await getAllIndicesInRepo(client, repo.name);
    if (snapshotIndices.length === 0) {
      outcome.skipped_reason = 'no snapshots in repo';
      return outcome;
    }

    const mounted = await resolveMountedIndexNames(client, snapshotIndices);
    if (mounted.length === 0) {
      outcome.skipped_reason = 'no mounted indices found for snapshot contents';
      return outcome;
    }

    const { earliest, latest } = await getTimestampRange(client, mounted);
    if (!earliest || !latest) {
      outcome.skipped_reason = 'aggregation returned no @timestamp values';
      return outcome;
    }

    // Only-extend merge: if existing dates are present, take the union.
    let final_start = earliest;
    let final_end = latest;
    if (repo.start && repo.end) {
      final_start = repo.start < earliest ? repo.start : earliest;
      final_end = repo.end > latest ? repo.end : latest;
      if (final_start === repo.start && final_end === repo.end) {
        outcome.skipped_reason = 'no change after only-extend merge';
        return outcome;
      }
    }

    const next: RepositoryDoc = {
      ...repo,
      start: final_start,
      end: final_end,
    };
    await saveRepositoryDoc(client, next);
    outcome.changed = true;
    outcome.start = final_start;
    outcome.end = final_end;
    return outcome;
  } catch (err) {
    outcome.error = err instanceof Error ? err.message : String(err);
    return outcome;
  }
}
