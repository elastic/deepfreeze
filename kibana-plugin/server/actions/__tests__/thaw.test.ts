import {
  checkAndMaybeMount,
  DEFAULT_RESTORE_DAYS,
  DEFAULT_RETRIEVAL_TIER,
  inspectThawProgress,
  runThaw,
  runThawDryRun,
  type ThawActionEsClient,
} from '../thaw';
import { ActionError, MissingIndexError, MissingSettingsError } from '../../errors';
import {
  SETTINGS_DEFAULTS,
  type SettingsDoc,
} from '../../../common/schemas/settings';
import type { RepositoryDoc } from '../../../common/schemas/repository';
import type { ThawRequestDoc } from '../../../common/schemas/thaw_request';
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
  /** Thaw request docs the client should serve from search by request_id. */
  thawRequests?: ThawRequestDoc[];
}

interface ClientTrace {
  index_calls: Array<{ index: string; id: string; document: Record<string, unknown> }>;
  createRepo_calls: Array<{ name: string; repository: { type: string; settings: Record<string, unknown> } }>;
}

function makeClient(opts: FakeOpts = {}): { client: ThawActionEsClient; trace: ClientTrace } {
  const trace: ClientTrace = { index_calls: [], createRepo_calls: [] };

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
      if (params.index !== STATUS_INDEX) return { hits: { hits: [] } };
      const query = (params.query ?? {}) as Record<string, unknown>;
      // thaw_request lookup by request_id
      const term = query.term as Record<string, unknown> | undefined;
      if (term && typeof term.request_id === 'string') {
        const found = (opts.thawRequests ?? []).find(
          (r) => r.request_id === term.request_id
        );
        return {
          hits: {
            hits: found
              ? [{ _id: found.request_id, _source: found as unknown as Record<string, unknown> }]
              : [],
          },
        };
      }
      // findReposByDateRange / getAllRepos — both resolve to the repos list.
      const repos = opts.repos ?? [];
      return {
        hits: {
          hits: repos.map((r) => ({ _id: r.name, _source: r as unknown as Record<string, unknown> })),
        },
      };
    },
    snapshot: {
      getRepository: async () => ({}),
      createRepository: async ({ name, repository }) => {
        trace.createRepo_calls.push({ name, repository });
        return {};
      },
      deleteRepository: async () => ({}),
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

  it('threads a custom restore_days into both restoreObject and expires_at', async () => {
    const repo = makeRepo();
    const { client, trace } = makeClient({ repos: [repo] });
    const { storage, trace: storageTrace } = makeStorage({
      objects: {
        [`${repo.bucket}/${repo.base_path}`]: [
          { key: `${repo.base_path}/g1`, size: 1, storage_class: 'GLACIER' },
        ],
      },
    });

    await runThaw(
      client,
      storage,
      {
        start_date: '2026-01-15T00:00:00Z',
        end_date: '2026-01-20T00:00:00Z',
        restore_days: 14,
      },
      {
        generateRequestId: () => 'r-days',
        now: () => new Date('2026-05-17T12:00:00Z'),
      }
    );

    // S3 restore uses the custom window.
    expect(storageTrace.restoreCalls[0].opts).toMatchObject({
      days: 14,
      tier: DEFAULT_RETRIEVAL_TIER,
    });
    // expires_at = now + 14 days
    const repoWrite = trace.index_calls.find((c) => c.id === repo.name);
    expect(repoWrite!.document).toMatchObject({
      expires_at: '2026-05-31T12:00:00.000Z',
    });
  });

  it('threads a custom retrieval_tier into restoreObject', async () => {
    const repo = makeRepo();
    const { client } = makeClient({ repos: [repo] });
    const { storage, trace: storageTrace } = makeStorage({
      objects: {
        [`${repo.bucket}/${repo.base_path}`]: [
          { key: `${repo.base_path}/g1`, size: 1, storage_class: 'GLACIER' },
        ],
      },
    });

    await runThaw(
      client,
      storage,
      {
        start_date: '2026-01-15T00:00:00Z',
        end_date: '2026-01-20T00:00:00Z',
        retrieval_tier: 'Expedited',
      },
      { generateRequestId: () => 'r-tier' }
    );

    expect(storageTrace.restoreCalls[0].opts).toMatchObject({
      days: DEFAULT_RESTORE_DAYS,
      tier: 'Expedited',
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

function makeThawRequest(over: Partial<ThawRequestDoc> = {}): ThawRequestDoc {
  return {
    doctype: 'thaw_request',
    request_id: 'req-a',
    repos: ['deepfreeze-000001'],
    status: 'in_progress',
    created_at: '2026-05-17T12:00:00Z',
    start_date: '2026-01-15T00:00:00Z',
    end_date: '2026-01-20T00:00:00Z',
    ...over,
  };
}

describe('inspectThawProgress', () => {
  it('throws ActionError when the request_id is unknown', async () => {
    const { client } = makeClient({ thawRequests: [] });
    const { storage } = makeStorage();
    await expect(
      inspectThawProgress(client, storage, 'missing-id')
    ).rejects.toBeInstanceOf(ActionError);
  });

  it('short-circuits for terminal status (returns empty repos, all_complete derived)', async () => {
    const request = makeThawRequest({ status: 'completed' });
    const { client } = makeClient({ thawRequests: [request] });
    const { storage, trace } = makeStorage();
    const result = await inspectThawProgress(client, storage, 'req-a');
    expect(result.status).toBe('completed');
    expect(result.all_complete).toBe(true);
    expect(result.repos).toEqual([]);
    expect(trace.headCalls).toEqual([]);
  });

  it('counts restored vs in_progress vs not_restored per repo', async () => {
    const repo = makeRepo({ name: 'r1' });
    const request = makeThawRequest({ repos: ['r1'] });
    const { client } = makeClient({ thawRequests: [request], repos: [repo] });
    const { storage } = makeStorage({
      objects: {
        [`${repo.bucket}/${repo.base_path}`]: [
          { key: 'a', size: 1, storage_class: 'STANDARD' },
          { key: 'b', size: 1, storage_class: 'GLACIER' },
          { key: 'c', size: 1, storage_class: 'GLACIER' },
        ],
      },
      heads: {
        [`${repo.bucket}/a`]: { storage_class: 'STANDARD', accessible: true, restore: null },
        [`${repo.bucket}/b`]: {
          storage_class: 'GLACIER',
          accessible: false,
          restore: { ongoing: true },
        },
        [`${repo.bucket}/c`]: { storage_class: 'GLACIER', accessible: false, restore: null },
      },
    });

    const result = await inspectThawProgress(client, storage, 'req-a');
    expect(result.status).toBe('in_progress');
    expect(result.all_complete).toBe(false);
    expect(result.repos).toEqual([
      {
        repo: 'r1',
        bucket: repo.bucket,
        base_path: repo.base_path,
        total: 3,
        restored: 1,
        in_progress: 1,
        not_restored: 1,
        complete: false,
      },
    ]);
  });

  it('flags all_complete=true when every object is in a hot tier', async () => {
    const repo = makeRepo({ name: 'r1' });
    const request = makeThawRequest({ repos: ['r1'] });
    const { client } = makeClient({ thawRequests: [request], repos: [repo] });
    const { storage } = makeStorage({
      objects: {
        [`${repo.bucket}/${repo.base_path}`]: [
          { key: 'a', size: 1, storage_class: 'STANDARD' },
          { key: 'b', size: 1, storage_class: 'STANDARD' },
        ],
      },
      defaultStorageClass: 'STANDARD',
    });

    const result = await inspectThawProgress(client, storage, 'req-a');
    expect(result.all_complete).toBe(true);
    expect(result.repos[0].complete).toBe(true);
  });

  it('records per-repo head failures as warnings and continues', async () => {
    const repo = makeRepo({ name: 'r1' });
    const request = makeThawRequest({ repos: ['r1'] });
    const { client } = makeClient({ thawRequests: [request], repos: [repo] });
    const failingStorage: StorageClient = {
      testConnection: async () => true,
      listObjects: async () => {
        throw new Error('list boom');
      },
      headObject: async () => ({
        storage_class: 'GLACIER',
        accessible: false,
        restore: null,
      }),
      restoreObject: async () => {},
    };

    const result = await inspectThawProgress(client, failingStorage, 'req-a');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].target).toBe('r1');
    expect(result.all_complete).toBe(false);
  });
});

describe('checkAndMaybeMount', () => {
  it('returns in_progress without mounting when objects are still restoring', async () => {
    const repo = makeRepo({ name: 'r1' });
    const request = makeThawRequest({ repos: ['r1'] });
    const { client, trace } = makeClient({ thawRequests: [request], repos: [repo] });
    const { storage } = makeStorage({
      objects: {
        [`${repo.bucket}/${repo.base_path}`]: [
          { key: 'a', size: 1, storage_class: 'GLACIER' },
        ],
      },
      heads: {
        [`${repo.bucket}/a`]: {
          storage_class: 'GLACIER',
          accessible: false,
          restore: { ongoing: true },
        },
      },
    });

    const result = await checkAndMaybeMount(client, storage, 'req-a');
    expect(result.status).toBe('in_progress');
    expect(result.all_complete).toBe(false);
    expect(result.mounted).toBeUndefined();
    expect(trace.createRepo_calls).toEqual([]);
  });

  it('mounts repos and flips status to completed when all restores are done', async () => {
    const repo = makeRepo({ name: 'r1' });
    const request = makeThawRequest({ repos: ['r1'] });
    const { client, trace } = makeClient({ thawRequests: [request], repos: [repo] });
    const { storage } = makeStorage({
      objects: {
        [`${repo.bucket}/${repo.base_path}`]: [
          { key: 'a', size: 1, storage_class: 'STANDARD' },
        ],
      },
      defaultStorageClass: 'STANDARD',
    });

    const result = await checkAndMaybeMount(client, storage, 'req-a', {
      now: () => new Date('2026-05-17T12:00:00Z'),
    });
    expect(result.status).toBe('completed');
    expect(result.all_complete).toBe(true);
    expect(result.mounted).toBe(true);
    expect(trace.createRepo_calls).toEqual([
      {
        name: 'r1',
        repository: {
          type: 's3',
          settings: {
            bucket: repo.bucket,
            base_path: repo.base_path,
            canned_acl: SETTINGS_DEFAULTS.canned_acl,
            storage_class: SETTINGS_DEFAULTS.storage_class,
          },
        },
      },
    ]);
    const reqWrite = trace.index_calls.find((c) => c.id === 'req-a');
    expect(reqWrite!.document).toMatchObject({ status: 'completed' });
    const repoWrite = trace.index_calls.find((c) => c.id === 'r1');
    expect(repoWrite!.document).toMatchObject({
      thaw_state: 'thawed',
      is_mounted: true,
      is_thawed: true,
      thawed_at: '2026-05-17T12:00:00.000Z',
    });
  });

  it('flips status to failed when a repo mount throws', async () => {
    const repo = makeRepo({ name: 'r1' });
    const request = makeThawRequest({ repos: ['r1'] });
    const { client, trace } = makeClient({ thawRequests: [request], repos: [repo] });
    client.snapshot.createRepository = async () => {
      throw new Error('verify failed: bucket unreachable');
    };
    const { storage } = makeStorage({
      objects: {
        [`${repo.bucket}/${repo.base_path}`]: [
          { key: 'a', size: 1, storage_class: 'STANDARD' },
        ],
      },
      defaultStorageClass: 'STANDARD',
    });

    const result = await checkAndMaybeMount(client, storage, 'req-a');
    expect(result.status).toBe('failed');
    expect(result.all_complete).toBe(true);
    expect(result.mounted).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].severity).toBe('error');
    expect(result.errors[0].target).toBe('r1');
    const reqWrite = trace.index_calls.find((c) => c.id === 'req-a');
    expect(reqWrite!.document).toMatchObject({ status: 'failed' });
  });

  it('does not mount or write if the request is already in terminal state', async () => {
    const request = makeThawRequest({ status: 'refrozen' });
    const { client, trace } = makeClient({ thawRequests: [request] });
    const { storage } = makeStorage();
    const result = await checkAndMaybeMount(client, storage, 'req-a');
    expect(result.status).toBe('refrozen');
    expect(trace.createRepo_calls).toEqual([]);
    expect(trace.index_calls).toEqual([]);
  });

  it('throws MissingSettingsError when settings are absent', async () => {
    const request = makeThawRequest();
    const { client } = makeClient({ thawRequests: [request], settings: null });
    const { storage } = makeStorage();
    await expect(
      checkAndMaybeMount(client, storage, 'req-a')
    ).rejects.toBeInstanceOf(MissingSettingsError);
  });
});
