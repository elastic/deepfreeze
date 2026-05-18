import {
  inferDiscrepancy,
  runRepairMetadata,
  runRepairMetadataDryRun,
  type ActualStorageState,
  type RepairMetadataActionEsClient,
} from '../repair_metadata';
import { MissingIndexError, MissingSettingsError } from '../../errors';
import {
  SETTINGS_DEFAULTS,
  type SettingsDoc,
} from '../../../common/schemas/settings';
import type { RepositoryDoc } from '../../../common/schemas/repository';
import type {
  ObjectRestoreState,
  StorageClient,
  StorageObject,
} from '../../storage/types';
import { SETTINGS_ID, STATUS_INDEX } from '../../../common/constants';

interface FakeOpts {
  settings?: SettingsDoc | null;
  noStatusIndex?: boolean;
  repos?: RepositoryDoc[];
  /** Map of repo name → list of snapshot index names. */
  snapshotIndices?: Record<string, string[]>;
  /** Indices that should exist when `indices.exists` is queried. */
  existingIndices?: string[];
  /** Min/max @timestamp returned by the search aggregation. */
  timestampRange?: { earliest: string | null; latest: string | null };
  /** Make `search` aggregation throw. */
  searchAggThrows?: boolean;
}

interface ClientTrace {
  index_calls: Array<{ index: string; id: string; document: Record<string, unknown> }>;
  agg_searches: Array<{ index: string }>;
}

function makeClient(opts: FakeOpts = {}): {
  client: RepairMetadataActionEsClient;
  trace: ClientTrace;
} {
  const trace: ClientTrace = { index_calls: [], agg_searches: [] };
  // Mutable repos so post-repair refetches reflect persisted state.
  const reposState: RepositoryDoc[] = [...(opts.repos ?? [])];
  const existing = new Set(opts.existingIndices ?? []);

  const client: RepairMetadataActionEsClient = {
    indices: {
      exists: async ({ index }) => {
        if (opts.noStatusIndex && index === STATUS_INDEX) return false;
        if (index === STATUS_INDEX) return true;
        return existing.has(index);
      },
    },
    get: async ({ id }) => {
      if (id === SETTINGS_ID) {
        if (opts.settings === null) return { found: false };
        return { _source: opts.settings ?? SETTINGS_DEFAULTS, found: true };
      }
      return { found: false };
    },
    search: async (params) => {
      // Aggregation search (date-range phase).
      if (params.aggs) {
        trace.agg_searches.push({ index: params.index });
        if (opts.searchAggThrows) {
          throw new Error('agg search boom');
        }
        const range = opts.timestampRange ?? { earliest: null, latest: null };
        return {
          aggregations: {
            earliest: { value_as_string: range.earliest ?? undefined },
            latest: { value_as_string: range.latest ?? undefined },
          },
        };
      }
      // Repo list search.
      if (params.index !== STATUS_INDEX) return { hits: { hits: [] } };
      return {
        hits: {
          hits: reposState.map((r) => ({
            _id: r.name,
            _source: r as unknown as Record<string, unknown>,
          })),
        },
      };
    },
    snapshot: {
      get: async ({ repository }) => {
        const indices = opts.snapshotIndices?.[repository] ?? [];
        return {
          snapshots: indices.length
            ? [{ snapshot: 'snap-1', indices: [...indices] }]
            : [],
        };
      },
      getRepository: async () => ({}),
    },
    index: async ({ index, id, document }) => {
      trace.index_calls.push({ index, id, document });
      // Reflect the write so subsequent getAllRepos sees post-repair state.
      const i = reposState.findIndex((r) => r.name === id);
      if (i >= 0) {
        reposState[i] = document as unknown as RepositoryDoc;
      }
      return {};
    },
  };
  return { client, trace };
}

interface FakeStorageOpts {
  objects?: Record<string, StorageObject[]>;
  heads?: Record<string, ObjectRestoreState>;
  /** Make listObjects throw for a specific bucket/prefix key. */
  listFailsFor?: string[];
}

function makeStorage(opts: FakeStorageOpts = {}): StorageClient {
  return {
    testConnection: async () => true,
    listObjects: async (bucket, prefix) => {
      const key = `${bucket}/${prefix}`;
      if (opts.listFailsFor?.includes(key)) {
        throw new Error(`list boom for ${key}`);
      }
      return opts.objects?.[key] ?? [];
    },
    headObject: async (bucket, key) => {
      const explicit = opts.heads?.[`${bucket}/${key}`];
      if (explicit) return explicit;
      return { storage_class: 'GLACIER', accessible: false, restore: null };
    },
    restoreObject: async () => {},
  };
}

function makeRepo(over: Partial<RepositoryDoc> = {}): RepositoryDoc {
  return {
    doctype: 'repository',
    name: 'r1',
    bucket: 'bdw',
    base_path: 'deepfreeze/snap',
    start: null,
    end: null,
    is_thawed: false,
    is_mounted: true,
    thaw_state: 'active',
    thawed_at: null,
    expires_at: null,
    ...over,
  };
}

function state(over: Partial<ActualStorageState> = {}): ActualStorageState {
  return {
    total_objects: 0,
    storage_classes: {},
    instant_access: 0,
    glacier: 0,
    restoring: 0,
    ...over,
  };
}

describe('inferDiscrepancy', () => {
  it('returns null for empty buckets (cannot decide)', () => {
    expect(inferDiscrepancy('frozen', state())).toBeNull();
    expect(inferDiscrepancy('active', state())).toBeNull();
  });

  it('active/thawed with all-glacier → frozen', () => {
    expect(inferDiscrepancy('active', state({ total_objects: 5, glacier: 5 }))).toBe(
      'frozen'
    );
    expect(inferDiscrepancy('thawed', state({ total_objects: 5, glacier: 5 }))).toBe(
      'frozen'
    );
  });

  it('active/thawed with some restoring → thawing', () => {
    expect(
      inferDiscrepancy(
        'active',
        state({ total_objects: 5, instant_access: 2, glacier: 1, restoring: 2 })
      )
    ).toBe('thawing');
  });

  it('frozen with all-accessible → thawed', () => {
    expect(
      inferDiscrepancy('frozen', state({ total_objects: 5, instant_access: 5 }))
    ).toBe('thawed');
  });

  it('frozen with some restoring → thawing', () => {
    expect(
      inferDiscrepancy(
        'frozen',
        state({ total_objects: 5, glacier: 3, restoring: 2 })
      )
    ).toBe('thawing');
  });

  it('thawing with all-glacier → frozen (thaw failed)', () => {
    expect(
      inferDiscrepancy('thawing', state({ total_objects: 5, glacier: 5 }))
    ).toBe('frozen');
  });

  it('thawing with all-accessible → thawed (thaw completed)', () => {
    expect(
      inferDiscrepancy('thawing', state({ total_objects: 5, instant_access: 5 }))
    ).toBe('thawed');
  });

  it('expired with all-accessible → thawed', () => {
    expect(
      inferDiscrepancy('expired', state({ total_objects: 5, instant_access: 5 }))
    ).toBe('thawed');
  });

  it('returns null when recorded matches actual (consistent)', () => {
    expect(
      inferDiscrepancy('frozen', state({ total_objects: 5, glacier: 5 }))
    ).toBeNull();
    expect(
      inferDiscrepancy('active', state({ total_objects: 5, instant_access: 5 }))
    ).toBeNull();
  });
});

describe('runRepairMetadata — preconditions', () => {
  it('throws MissingIndexError when status index is absent', async () => {
    const { client } = makeClient({ noStatusIndex: true });
    await expect(
      runRepairMetadata(client, makeStorage())
    ).rejects.toBeInstanceOf(MissingIndexError);
  });

  it('throws MissingSettingsError when settings doc is missing', async () => {
    const { client } = makeClient({ settings: null });
    await expect(
      runRepairMetadata(client, makeStorage())
    ).rejects.toBeInstanceOf(MissingSettingsError);
  });
});

describe('runRepairMetadata — scan and repair', () => {
  it('detects an active-but-actually-frozen repo and flips it', async () => {
    const repo = makeRepo({ name: 'r1', thaw_state: 'active' });
    const { client, trace } = makeClient({ repos: [repo] });
    const storage = makeStorage({
      objects: {
        [`${repo.bucket}/${repo.base_path}/`]: [
          { key: 'a', size: 1, storage_class: 'GLACIER' },
          { key: 'b', size: 1, storage_class: 'GLACIER' },
        ],
      },
    });
    const result = await runRepairMetadata(client, storage);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]).toMatchObject({
      repo: 'r1',
      recorded_state: 'active',
      actual_state: 'frozen',
      glacier: 2,
      instant_access: 0,
    });
    expect(result.repaired).toEqual([
      { repo: 'r1', from: 'active', to: 'frozen', success: true },
    ]);
    const write = trace.index_calls.find((c) => c.id === 'r1');
    expect(write!.document).toMatchObject({
      thaw_state: 'frozen',
      is_mounted: false,
      is_thawed: false,
    });
  });

  it('detects a frozen-but-now-accessible repo and flips it to thawed', async () => {
    const repo = makeRepo({ name: 'r1', thaw_state: 'frozen', is_mounted: false });
    const { client, trace } = makeClient({ repos: [repo] });
    const storage = makeStorage({
      objects: {
        [`${repo.bucket}/${repo.base_path}/`]: [
          { key: 'a', size: 1, storage_class: 'STANDARD' },
        ],
      },
    });
    const result = await runRepairMetadata(client, storage);
    expect(result.discrepancies[0].actual_state).toBe('thawed');
    expect(result.repaired[0]).toMatchObject({ from: 'frozen', to: 'thawed' });
    const write = trace.index_calls.find((c) => c.id === 'r1');
    expect(write!.document).toMatchObject({
      thaw_state: 'thawed',
      is_thawed: true,
      // is_mounted should be preserved (not forced to false) since new
      // state is thawed, not frozen.
      is_mounted: false,
    });
  });

  it('classifies restoring objects via headObject and flips frozen → thawing', async () => {
    const repo = makeRepo({ name: 'r1', thaw_state: 'frozen' });
    const { client } = makeClient({ repos: [repo] });
    const storage = makeStorage({
      objects: {
        [`${repo.bucket}/${repo.base_path}/`]: [
          { key: 'a', size: 1, storage_class: 'GLACIER' },
          { key: 'b', size: 1, storage_class: 'GLACIER' },
        ],
      },
      heads: {
        [`${repo.bucket}/a`]: {
          storage_class: 'GLACIER',
          accessible: false,
          restore: { ongoing: true },
        },
        [`${repo.bucket}/b`]: {
          storage_class: 'GLACIER',
          accessible: false,
          restore: null,
        },
      },
    });
    const result = await runRepairMetadata(client, storage);
    expect(result.discrepancies[0]).toMatchObject({
      actual_state: 'thawing',
      restoring: 1,
      glacier: 1,
    });
  });

  it('records inspection errors but does not crash the scan', async () => {
    const r1 = makeRepo({ name: 'r1', bucket: 'bdw', base_path: 'a' });
    const r2 = makeRepo({ name: 'r2', bucket: 'bdw', base_path: 'b', thaw_state: 'active' });
    const { client } = makeClient({ repos: [r1, r2] });
    const storage = makeStorage({
      listFailsFor: ['bdw/a/'],
      objects: {
        'bdw/b/': [{ key: 'b1', size: 1, storage_class: 'GLACIER' }],
      },
    });
    const result = await runRepairMetadata(client, storage);
    // r1 failed inspection; r2 successfully diagnosed as frozen
    expect(result.discrepancies).toHaveLength(2);
    const r1d = result.discrepancies.find((d) => d.repo === 'r1')!;
    expect(r1d.error).toBeDefined();
    expect(r1d.actual_state).toBeNull();
    const r2d = result.discrepancies.find((d) => d.repo === 'r2')!;
    expect(r2d.actual_state).toBe('frozen');
    // r1 cannot be repaired (no suggested state); r2 was repaired
    expect(result.repaired).toEqual([
      { repo: 'r2', from: 'active', to: 'frozen', success: true },
    ]);
    expect(result.errors.some((e) => e.target === 'r1')).toBe(true);
  });

  it('does not flag a repo whose recorded state matches actual', async () => {
    const repo = makeRepo({ name: 'r1', thaw_state: 'active' });
    const { client, trace } = makeClient({ repos: [repo] });
    const storage = makeStorage({
      objects: {
        [`${repo.bucket}/${repo.base_path}/`]: [
          { key: 'a', size: 1, storage_class: 'STANDARD' },
        ],
      },
    });
    const result = await runRepairMetadata(client, storage);
    expect(result.discrepancies).toEqual([]);
    expect(result.repaired).toEqual([]);
    expect(trace.index_calls).toEqual([]);
  });
});

describe('runRepairMetadataDryRun', () => {
  it('reports discrepancies without writing', async () => {
    const repo = makeRepo({ name: 'r1', thaw_state: 'active' });
    const { client, trace } = makeClient({ repos: [repo] });
    const storage = makeStorage({
      objects: {
        [`${repo.bucket}/${repo.base_path}/`]: [
          { key: 'a', size: 1, storage_class: 'GLACIER' },
        ],
      },
    });
    const result = await runRepairMetadataDryRun(client, storage);
    expect(result.dry_run).toBe(true);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.repaired).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(trace.index_calls).toEqual([]);
  });

  it('lists mounted repos missing date ranges as dry-run candidates', async () => {
    const mountedNoRange = makeRepo({
      name: 'r1',
      is_mounted: true,
      start: null,
      end: null,
    });
    const mountedWithRange = makeRepo({
      name: 'r2',
      is_mounted: true,
      start: '2026-01-01T00:00:00Z',
      end: '2026-01-31T00:00:00Z',
    });
    const unmounted = makeRepo({
      name: 'r3',
      is_mounted: false,
      start: null,
      end: null,
    });
    const { client, trace } = makeClient({
      repos: [mountedNoRange, mountedWithRange, unmounted],
    });
    const storage = makeStorage();
    const result = await runRepairMetadataDryRun(client, storage);
    expect(result.date_ranges).toHaveLength(1);
    expect(result.date_ranges[0].repo).toBe('r1');
    expect(result.date_ranges[0].skipped_reason).toMatch(/dry-run/);
    // No aggregation hit in dry-run.
    expect(trace.agg_searches).toEqual([]);
  });
});

describe('runRepairMetadata — date-range phase', () => {
  it('skips unmounted repos (cannot query @timestamp)', async () => {
    const repo = makeRepo({
      name: 'r1',
      is_mounted: false,
      start: null,
      end: null,
      thaw_state: 'frozen',
    });
    const { client, trace } = makeClient({ repos: [repo] });
    const storage = makeStorage({
      objects: { [`${repo.bucket}/${repo.base_path}/`]: [] },
    });
    const result = await runRepairMetadata(client, storage);
    expect(result.date_ranges).toEqual([]);
    expect(trace.agg_searches).toEqual([]);
  });

  it('skips repos that already have both start and end set', async () => {
    const repo = makeRepo({
      name: 'r1',
      is_mounted: true,
      start: '2026-01-01T00:00:00Z',
      end: '2026-01-31T00:00:00Z',
      thaw_state: 'active',
    });
    const { client, trace } = makeClient({
      repos: [repo],
      snapshotIndices: { r1: ['idx-1'] },
      existingIndices: ['idx-1'],
    });
    const storage = makeStorage({
      objects: {
        [`${repo.bucket}/${repo.base_path}/`]: [
          { key: 'a', size: 1, storage_class: 'STANDARD' },
        ],
      },
    });
    const result = await runRepairMetadata(client, storage);
    expect(result.date_ranges).toEqual([]);
    expect(trace.agg_searches).toEqual([]);
  });

  it('resolves base index name and persists the queried range', async () => {
    const repo = makeRepo({
      name: 'r1',
      is_mounted: true,
      start: null,
      end: null,
      thaw_state: 'active',
    });
    const { client, trace } = makeClient({
      repos: [repo],
      snapshotIndices: { r1: ['logs-2026-01'] },
      existingIndices: ['logs-2026-01'],
      timestampRange: {
        earliest: '2026-01-05T00:00:00Z',
        latest: '2026-01-28T23:59:59Z',
      },
    });
    const storage = makeStorage({
      objects: {
        [`${repo.bucket}/${repo.base_path}/`]: [
          { key: 'a', size: 1, storage_class: 'STANDARD' },
        ],
      },
    });
    const result = await runRepairMetadata(client, storage);
    expect(result.date_ranges).toHaveLength(1);
    expect(result.date_ranges[0]).toMatchObject({
      repo: 'r1',
      changed: true,
      start: '2026-01-05T00:00:00Z',
      end: '2026-01-28T23:59:59Z',
      previous_start: null,
      previous_end: null,
    });
    // The aggregation hit the resolved index name.
    expect(trace.agg_searches).toEqual([{ index: 'logs-2026-01' }]);
    // The repo doc was written with the new range.
    const writes = trace.index_calls.filter((c) => c.id === 'r1');
    const finalWrite = writes[writes.length - 1];
    expect(finalWrite.document).toMatchObject({
      start: '2026-01-05T00:00:00Z',
      end: '2026-01-28T23:59:59Z',
    });
  });

  it('resolves "partial-" prefix when base name does not exist', async () => {
    const repo = makeRepo({
      name: 'r1',
      is_mounted: true,
      start: null,
      end: null,
    });
    const { client, trace } = makeClient({
      repos: [repo],
      snapshotIndices: { r1: ['logs-feb'] },
      // Base name missing; partial- variant present (typical for searchable snaps).
      existingIndices: ['partial-logs-feb'],
      timestampRange: { earliest: '2026-02-01T00:00:00Z', latest: '2026-02-28T00:00:00Z' },
    });
    const storage = makeStorage();
    const result = await runRepairMetadata(client, storage);
    expect(trace.agg_searches).toEqual([{ index: 'partial-logs-feb' }]);
    expect(result.date_ranges[0].changed).toBe(true);
  });

  it('strips fm-clone-<random>- prefix before resolving', async () => {
    const repo = makeRepo({
      name: 'r1',
      is_mounted: true,
      start: null,
      end: null,
    });
    const { client, trace } = makeClient({
      repos: [repo],
      snapshotIndices: { r1: ['fm-clone-abc123-logs-mar'] },
      existingIndices: ['logs-mar'],
      timestampRange: { earliest: '2026-03-01T00:00:00Z', latest: '2026-03-31T00:00:00Z' },
    });
    const storage = makeStorage();
    const result = await runRepairMetadata(client, storage);
    expect(trace.agg_searches).toEqual([{ index: 'logs-mar' }]);
    expect(result.date_ranges[0].changed).toBe(true);
  });

  it('records skipped_reason when no mounted index variant is found', async () => {
    const repo = makeRepo({
      name: 'r1',
      is_mounted: true,
      start: null,
      end: null,
    });
    const { client, trace } = makeClient({
      repos: [repo],
      snapshotIndices: { r1: ['logs-apr'] },
      // None of the variants (logs-apr, partial-logs-apr, restored-logs-apr) exist.
      existingIndices: [],
    });
    const storage = makeStorage();
    const result = await runRepairMetadata(client, storage);
    expect(result.date_ranges[0]).toMatchObject({
      changed: false,
      skipped_reason: 'no mounted indices found for snapshot contents',
    });
    expect(trace.agg_searches).toEqual([]);
  });

  it('records skipped_reason when @timestamp aggregation returns null', async () => {
    const repo = makeRepo({
      name: 'r1',
      is_mounted: true,
      start: null,
      end: null,
    });
    const { client } = makeClient({
      repos: [repo],
      snapshotIndices: { r1: ['idx'] },
      existingIndices: ['idx'],
      timestampRange: { earliest: null, latest: null },
    });
    const storage = makeStorage();
    const result = await runRepairMetadata(client, storage);
    expect(result.date_ranges[0]).toMatchObject({
      changed: false,
      skipped_reason: 'aggregation returned no @timestamp values',
    });
  });

  it('runs the date-range phase AFTER thaw_state repair (sees post-flip state)', async () => {
    // Recorded frozen + actually-instant-access → flips to thawed, which is
    // is_mounted=true so the date-range phase becomes eligible.
    const repo = makeRepo({
      name: 'r1',
      thaw_state: 'frozen',
      is_mounted: true, // already mounted but flagged frozen in metadata
      start: null,
      end: null,
    });
    const { client, trace } = makeClient({
      repos: [repo],
      snapshotIndices: { r1: ['idx'] },
      existingIndices: ['idx'],
      timestampRange: { earliest: '2026-04-01T00:00:00Z', latest: '2026-04-30T00:00:00Z' },
    });
    const storage = makeStorage({
      objects: {
        [`${repo.bucket}/${repo.base_path}/`]: [
          { key: 'a', size: 1, storage_class: 'STANDARD' },
        ],
      },
    });
    const result = await runRepairMetadata(client, storage);
    // First: state flipped frozen → thawed.
    expect(result.repaired[0]).toMatchObject({ from: 'frozen', to: 'thawed' });
    // Then: date range populated.
    expect(result.date_ranges[0].changed).toBe(true);
    // Two writes per repo: state flip + date range.
    expect(trace.index_calls.filter((c) => c.id === 'r1').length).toBeGreaterThanOrEqual(2);
  });
});
