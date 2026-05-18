import {
  DEFAULT_RESTORE_DAYS,
  DEFAULT_RETRIEVAL_TIER,
  runThaw,
  runThawDryRun,
  type ThawActionEsClient,
} from '../thaw';
import { MissingIndexError, MissingSettingsError } from '../../errors';
import {
  SETTINGS_DEFAULTS,
  type SettingsDoc,
} from '../../../common/schemas/settings';
import type { RepositoryDoc } from '../../../common/schemas/repository';
import type {
  ObjectRestoreState,
  RestoreOptions,
  StorageClient,
  StorageObject,
} from '../../storage/types';
import { SETTINGS_ID, STATUS_INDEX } from '../../../common/constants';

interface FakeOpts {
  settings?: SettingsDoc | null;
  /** When true, `indices.exists` returns false (no status index). */
  noStatusIndex?: boolean;
  repos?: RepositoryDoc[];
}

interface ClientTrace {
  index_calls: Array<{ index: string; id: string; document: Record<string, unknown> }>;
}

function makeClient(opts: FakeOpts = {}): { client: ThawActionEsClient; trace: ClientTrace } {
  const trace: ClientTrace = { index_calls: [] };

  const client: ThawActionEsClient = {
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
      // We model both `getAllRepos`-style and `findReposByDateRange`-style
      // searches against the status index. For the date-range bool query
      // we return the configured repos verbatim; the test suite drives
      // overlap selection itself via `opts.repos`.
      if (params.index !== STATUS_INDEX) return { hits: { hits: [] } };
      const repos = opts.repos ?? [];
      return {
        hits: {
          hits: repos.map((r) => ({ _id: r.name, _source: r as unknown as Record<string, unknown> })),
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
    delete: async () => ({}),
  };

  return { client, trace };
}

/** Test fixture: configurable storage client. */
interface FakeStorageOpts {
  /** Map of bucket+key → object listing entries. */
  objects?: Record<string, StorageObject[]>;
  /** Map of `bucket/key` → fixed ObjectRestoreState. */
  heads?: Record<string, ObjectRestoreState>;
  /** Keys for which restoreObject should throw. */
  failRestoreKeys?: string[];
  /** Default storage_class for objects without an explicit head entry. */
  defaultStorageClass?: string;
}

interface StorageTrace {
  restoreCalls: Array<{ bucket: string; key: string; opts: RestoreOptions }>;
  headCalls: Array<{ bucket: string; key: string }>;
}

function makeStorage(opts: FakeStorageOpts = {}): { storage: StorageClient; trace: StorageTrace } {
  const trace: StorageTrace = { restoreCalls: [], headCalls: [] };
  const storage: StorageClient = {
    testConnection: async () => true,
    listObjects: async (bucket, prefix) => opts.objects?.[`${bucket}/${prefix}`] ?? [],
    headObject: async (bucket, key) => {
      trace.headCalls.push({ bucket, key });
      const explicit = opts.heads?.[`${bucket}/${key}`];
      if (explicit) return explicit;
      const storage_class = opts.defaultStorageClass ?? 'GLACIER';
      return {
        storage_class,
        accessible: storage_class === 'STANDARD' || storage_class === 'STANDARD_IA',
        restore: null,
      };
    },
    restoreObject: async (bucket, key, restoreOpts) => {
      if (opts.failRestoreKeys?.includes(key)) {
        throw new Error(`boom-restore-${key}`);
      }
      trace.restoreCalls.push({ bucket, key, opts: restoreOpts });
    },
  };
  return { storage, trace };
}

function makeRepo(over: Partial<RepositoryDoc> = {}): RepositoryDoc {
  return {
    doctype: 'repository',
    name: 'deepfreeze-000001',
    bucket: 'bdw-testing',
    base_path: 'deepfreeze/snapshots/jan',
    start: '2026-01-01T00:00:00Z',
    end: '2026-01-31T23:59:59Z',
    is_thawed: false,
    is_mounted: false,
    thaw_state: 'frozen',
    thawed_at: null,
    expires_at: null,
    ...over,
  };
}

describe('runThaw — preconditions', () => {
  it('throws MissingIndexError when the status index is absent', async () => {
    const { client } = makeClient({ noStatusIndex: true });
    const { storage } = makeStorage();
    await expect(
      runThaw(client, storage, {
        start_date: '2026-01-01T00:00:00Z',
        end_date: '2026-01-31T00:00:00Z',
      })
    ).rejects.toBeInstanceOf(MissingIndexError);
  });

  it('throws MissingSettingsError when settings doc is missing', async () => {
    const { client } = makeClient({ settings: null });
    const { storage } = makeStorage();
    await expect(
      runThaw(client, storage, {
        start_date: '2026-01-01T00:00:00Z',
        end_date: '2026-01-31T00:00:00Z',
      })
    ).rejects.toBeInstanceOf(MissingSettingsError);
  });
});

describe('runThaw — no overlapping repos', () => {
  it('returns a successful no-op result with null request_id', async () => {
    const { client, trace } = makeClient({ repos: [] });
    const { storage } = makeStorage();
    const result = await runThaw(client, storage, {
      start_date: '2026-01-01T00:00:00Z',
      end_date: '2026-01-31T00:00:00Z',
    });
    expect(result.success).toBe(true);
    expect(result.dry_run).toBe(false);
    expect(result.request_id).toBeNull();
    expect(result.repos).toEqual([]);
    expect(result.steps).toEqual([]);
    expect(trace.index_calls).toEqual([]);
  });
});

describe('runThaw — happy path', () => {
  it('saves the thaw request, restores Glacier objects, and flips repo thaw_state to thawing', async () => {
    const repo = makeRepo();
    const { client, trace } = makeClient({ repos: [repo] });
    const { storage, trace: storageTrace } = makeStorage({
      objects: {
        [`${repo.bucket}/${repo.base_path}`]: [
          { key: `${repo.base_path}/index-0`, size: 100, storage_class: 'GLACIER' },
          { key: `${repo.base_path}/index-1`, size: 200, storage_class: 'STANDARD' },
        ],
      },
      heads: {
        [`${repo.bucket}/${repo.base_path}/index-0`]: {
          storage_class: 'GLACIER',
          accessible: false,
          restore: null,
        },
        [`${repo.bucket}/${repo.base_path}/index-1`]: {
          storage_class: 'STANDARD',
          accessible: true,
          restore: null,
        },
      },
    });

    const result = await runThaw(
      client,
      storage,
      {
        start_date: '2026-01-15T00:00:00Z',
        end_date: '2026-01-20T00:00:00Z',
      },
      {
        generateRequestId: () => 'abcd1234',
        now: () => new Date('2026-05-17T12:00:00Z'),
      }
    );

    expect(result.success).toBe(true);
    expect(result.request_id).toBe('abcd1234');
    expect(result.repos).toEqual([repo.name]);
    expect(result.errors).toEqual([]);
    expect(result.repo_object_stats).toEqual([
      {
        repo: repo.name,
        total: 2,
        restore_initiated: 1,
        already_accessible: 1,
        failed: 0,
      },
    ]);

    // restoreObject called only for the GLACIER object, with hard-coded params.
    expect(storageTrace.restoreCalls).toEqual([
      {
        bucket: repo.bucket,
        key: `${repo.base_path}/index-0`,
        opts: { days: DEFAULT_RESTORE_DAYS, tier: DEFAULT_RETRIEVAL_TIER },
      },
    ]);

    // Two ES writes: thaw_request doc + repository doc.
    const thawWrite = trace.index_calls.find((c) => c.id === 'abcd1234');
    expect(thawWrite).toBeDefined();
    expect(thawWrite!.document).toMatchObject({
      doctype: 'thaw_request',
      request_id: 'abcd1234',
      repos: [repo.name],
      status: 'in_progress',
      start_date: '2026-01-15T00:00:00Z',
      end_date: '2026-01-20T00:00:00Z',
    });

    const repoWrite = trace.index_calls.find((c) => c.id === repo.name);
    expect(repoWrite).toBeDefined();
    expect(repoWrite!.document).toMatchObject({
      doctype: 'repository',
      name: repo.name,
      thaw_state: 'thawing',
      // expires_at = now + 7 days = 2026-05-24T12:00:00.000Z
      expires_at: '2026-05-24T12:00:00.000Z',
    });
  });

  it('saves the request doc BEFORE issuing restores (survives mid-flight crash)', async () => {
    const repo = makeRepo();
    const { client, trace } = makeClient({ repos: [repo] });
    const indexOrder: string[] = [];
    trace.index_calls = [];
    const origIndex = client.index;
    client.index = async (params) => {
      indexOrder.push(`index:${params.id}`);
      return origIndex(params);
    };

    const storageEvents: string[] = [];
    const storage: StorageClient = {
      testConnection: async () => true,
      listObjects: async () => [
        { key: `${repo.base_path}/x`, size: 1, storage_class: 'GLACIER' },
      ],
      headObject: async () => ({
        storage_class: 'GLACIER',
        accessible: false,
        restore: null,
      }),
      restoreObject: async () => {
        storageEvents.push('restore');
      },
    };

    await runThaw(
      client,
      storage,
      {
        start_date: '2026-01-15T00:00:00Z',
        end_date: '2026-01-20T00:00:00Z',
      },
      { generateRequestId: () => 'req-001' }
    );

    // The thaw_request doc must be the first index call, BEFORE any restore.
    expect(indexOrder[0]).toBe('index:req-001');
    expect(storageEvents).toEqual(['restore']);
    // Then the repository doc gets written.
    expect(indexOrder).toContain(`index:${repo.name}`);
  });
});

describe('runThaw — partial failure', () => {
  it('records per-object restore failures as warnings without aborting the repo', async () => {
    const repo = makeRepo();
    const { client } = makeClient({ repos: [repo] });
    const { storage } = makeStorage({
      objects: {
        [`${repo.bucket}/${repo.base_path}`]: [
          { key: 'a', size: 1, storage_class: 'GLACIER' },
          { key: 'b', size: 1, storage_class: 'GLACIER' },
        ],
      },
      failRestoreKeys: ['b'],
    });

    const result = await runThaw(
      client,
      storage,
      {
        start_date: '2026-01-01T00:00:00Z',
        end_date: '2026-01-31T00:00:00Z',
      },
      { generateRequestId: () => 'partial' }
    );

    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('ACTION_FAILED');
    expect(result.errors[0].severity).toBe('warning');
    expect(result.errors[0].target).toContain('b');
    expect(result.repo_object_stats[0]).toMatchObject({
      repo: repo.name,
      total: 2,
      restore_initiated: 1,
      failed: 1,
    });
    // Repo still flipped to thawing because the action didn't throw.
    expect(result.steps.some((s) => s.action === 'thawing')).toBe(true);
  });

  it('skips a repo with zero objects without flipping its thaw_state', async () => {
    const repo = makeRepo();
    const { client, trace } = makeClient({ repos: [repo] });
    const { storage } = makeStorage({
      objects: { [`${repo.bucket}/${repo.base_path}`]: [] },
    });

    const result = await runThaw(
      client,
      storage,
      {
        start_date: '2026-01-01T00:00:00Z',
        end_date: '2026-01-31T00:00:00Z',
      },
      { generateRequestId: () => 'empty' }
    );

    expect(result.repo_object_stats[0].total).toBe(0);
    expect(result.steps.some((s) => s.action === 'skipped')).toBe(true);
    expect(result.steps.some((s) => s.action === 'thawing')).toBe(false);

    // Only the thaw_request doc was written; no repository doc update.
    const writes = trace.index_calls.map((c) => c.id);
    expect(writes).toContain('empty');
    expect(writes).not.toContain(repo.name);
  });

  it('treats in-progress restores as already-accessible (no double-fire)', async () => {
    const repo = makeRepo();
    const { client } = makeClient({ repos: [repo] });
    const { storage, trace: st } = makeStorage({
      objects: {
        [`${repo.bucket}/${repo.base_path}`]: [
          { key: 'k', size: 1, storage_class: 'GLACIER' },
        ],
      },
      heads: {
        [`${repo.bucket}/k`]: {
          storage_class: 'GLACIER',
          accessible: false,
          restore: { ongoing: true },
        },
      },
    });

    const result = await runThaw(
      client,
      storage,
      {
        start_date: '2026-01-01T00:00:00Z',
        end_date: '2026-01-31T00:00:00Z',
      },
      { generateRequestId: () => 'inflight' }
    );

    expect(st.restoreCalls).toEqual([]);
    expect(result.repo_object_stats[0].already_accessible).toBe(1);
    expect(result.repo_object_stats[0].restore_initiated).toBe(0);
  });
});

describe('runThawDryRun', () => {
  it('previews repos without ES writes or S3 calls', async () => {
    const repo = makeRepo();
    const { client, trace } = makeClient({ repos: [repo] });
    const result = await runThawDryRun(client, {
      start_date: '2026-01-15T00:00:00Z',
      end_date: '2026-01-20T00:00:00Z',
    });
    expect(result.dry_run).toBe(true);
    expect(result.request_id).toBeNull();
    expect(result.repos).toEqual([repo.name]);
    expect(result.steps.some((s) => s.action === 'would_thaw')).toBe(true);
    expect(trace.index_calls).toEqual([]);
  });

  it('still validates settings before previewing', async () => {
    const { client } = makeClient({ settings: null });
    await expect(
      runThawDryRun(client, {
        start_date: '2026-01-01T00:00:00Z',
        end_date: '2026-01-31T00:00:00Z',
      })
    ).rejects.toBeInstanceOf(MissingSettingsError);
  });
});
