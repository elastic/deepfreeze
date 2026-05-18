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
}

interface ClientTrace {
  index_calls: Array<{ index: string; id: string; document: Record<string, unknown> }>;
}

function makeClient(opts: FakeOpts = {}): {
  client: RepairMetadataActionEsClient;
  trace: ClientTrace;
} {
  const trace: ClientTrace = { index_calls: [] };
  const client: RepairMetadataActionEsClient = {
    indices: {
      exists: async ({ index }) => {
        if (opts.noStatusIndex && index === STATUS_INDEX) return false;
        return true;
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
      if (params.index !== STATUS_INDEX) return { hits: { hits: [] } };
      const repos = opts.repos ?? [];
      return {
        hits: {
          hits: repos.map((r) => ({
            _id: r.name,
            _source: r as unknown as Record<string, unknown>,
          })),
        },
      };
    },
    snapshot: {
      getRepository: async () => ({}),
    },
    index: async ({ index, id, document }) => {
      trace.index_calls.push({ index, id, document });
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
});
