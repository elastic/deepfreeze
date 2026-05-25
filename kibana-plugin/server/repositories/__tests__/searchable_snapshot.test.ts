import {
  assignIlmPolicy,
  ensureThawedIlmPolicy,
  findLatestSnapshotForIndex,
  getAllIndicesInRepo,
  mountSnapshotIndex,
  stripFmClonePrefix,
  type SearchableSnapshotEsClient,
} from '../searchable_snapshot';

interface FakeOpts {
  /** Pre-canned response for `snapshot.get`. */
  snapshots?: Array<{ snapshot?: string; indices?: string[] }>;
  /** Set of mounted-index names that `indices.exists` should report as present. */
  existingIndices?: Set<string>;
  /** Throw on `indices.delete` for these names. */
  failDeleteForNames?: Set<string>;
  /** Throw on `searchable_snapshots.mount` for these `renamed_index` values. */
  failMountForNames?: Set<string>;
  /** Throw 404 on `ilm.getLifecycle` (simulates "policy doesn't exist yet"). */
  ilmGetLifecycleNotFound?: boolean;
  /** Throw a generic error on `ilm.removeLifecycle`. */
  failIlmRemove?: boolean;
}

interface Trace {
  mount_calls: Array<{ repository: string; snapshot: string; body: { index: string; renamed_index?: string } }>;
  ilm_get_calls: Array<{ name?: string }>;
  ilm_put_calls: Array<{ name: string; policy: Record<string, unknown> }>;
  ilm_remove_calls: Array<{ index: string }>;
  put_settings_calls: Array<{ index: string; body: Record<string, unknown> }>;
  delete_index_calls: string[];
}

function makeClient(opts: FakeOpts = {}): { client: SearchableSnapshotEsClient; trace: Trace } {
  const trace: Trace = {
    mount_calls: [],
    ilm_get_calls: [],
    ilm_put_calls: [],
    ilm_remove_calls: [],
    put_settings_calls: [],
    delete_index_calls: [],
  };
  const client: SearchableSnapshotEsClient = {
    snapshot: {
      get: async () => ({ snapshots: opts.snapshots ?? [] }),
    },
    searchableSnapshots: {
      mount: async (params) => {
        trace.mount_calls.push(params);
        const target = params.body.renamed_index ?? params.body.index;
        if (opts.failMountForNames?.has(target)) {
          throw new Error(`mount failed for ${target}`);
        }
        return {};
      },
    },
    indices: {
      exists: ({ index }) => (opts.existingIndices?.has(index) ?? false),
      delete: async ({ index }) => {
        trace.delete_index_calls.push(index);
        if (opts.failDeleteForNames?.has(index)) {
          throw new Error(`delete failed for ${index}`);
        }
        return {};
      },
      putSettings: async (params) => {
        trace.put_settings_calls.push(params);
        return {};
      },
    },
    ilm: {
      getLifecycle: async (params) => {
        trace.ilm_get_calls.push(params);
        if (opts.ilmGetLifecycleNotFound) {
          const err = new Error('not found') as Error & { statusCode?: number };
          err.statusCode = 404;
          throw err;
        }
        return { [params.name ?? '']: {} };
      },
      putLifecycle: async (params) => {
        trace.ilm_put_calls.push(params);
        return {};
      },
      removeLifecycle: async (params) => {
        trace.ilm_remove_calls.push(params);
        if (opts.failIlmRemove) {
          throw new Error('no current policy');
        }
        return {};
      },
    },
  };
  return { client, trace };
}

const noopLog = { debug: () => {}, warn: () => {} };

describe('stripFmClonePrefix', () => {
  it('returns the input unchanged when no fm-clone prefix is present', () => {
    expect(stripFmClonePrefix('logs-2026.05.23')).toBe('logs-2026.05.23');
  });

  it('strips fm-clone-<random>- from a typical force-merge clone name', () => {
    expect(stripFmClonePrefix('fm-clone-abc123-logs-2026.05.23')).toBe(
      'logs-2026.05.23'
    );
  });

  it('preserves hyphens in the original-name portion', () => {
    expect(stripFmClonePrefix('fm-clone-xy-some-app-logs-001')).toBe(
      'some-app-logs-001'
    );
  });

  it('returns the input unchanged for an unexpectedly short fm-clone name', () => {
    expect(stripFmClonePrefix('fm-clone-onlythree')).toBe('fm-clone-onlythree');
  });
});

describe('getAllIndicesInRepo', () => {
  it('returns the union of indices across every snapshot', async () => {
    const { client } = makeClient({
      snapshots: [
        { snapshot: 'snap-1', indices: ['logs-001', 'logs-002'] },
        { snapshot: 'snap-2', indices: ['logs-002', 'metrics-001'] },
      ],
    });
    const out = await getAllIndicesInRepo(client, 'deepfreeze-000001');
    expect(out.sort()).toEqual(['logs-001', 'logs-002', 'metrics-001']);
  });

  it('returns empty when the repo has no snapshots', async () => {
    const { client } = makeClient({ snapshots: [] });
    expect(await getAllIndicesInRepo(client, 'empty-repo')).toEqual([]);
  });
});

describe('findLatestSnapshotForIndex', () => {
  it('returns the last snapshot in the listed order that contains the index', async () => {
    const { client } = makeClient({
      snapshots: [
        { snapshot: 'snap-1', indices: ['logs-001'] },
        { snapshot: 'snap-2', indices: ['logs-001', 'logs-002'] },
        { snapshot: 'snap-3', indices: ['logs-002'] },
      ],
    });
    expect(await findLatestSnapshotForIndex(client, 'repo', 'logs-001')).toBe('snap-2');
    expect(await findLatestSnapshotForIndex(client, 'repo', 'logs-002')).toBe('snap-3');
  });

  it('returns null when no snapshot contains the index', async () => {
    const { client } = makeClient({
      snapshots: [{ snapshot: 'snap-1', indices: ['logs-001'] }],
    });
    expect(await findLatestSnapshotForIndex(client, 'repo', 'missing')).toBeNull();
  });
});

describe('ensureThawedIlmPolicy', () => {
  it('creates the policy with a 29d Delete phase when none exists', async () => {
    const { client, trace } = makeClient({ ilmGetLifecycleNotFound: true });
    const name = await ensureThawedIlmPolicy(client, 'deepfreeze-000011');

    expect(name).toBe('deepfreeze-000011-thawed');
    expect(trace.ilm_put_calls).toHaveLength(1);
    expect(trace.ilm_put_calls[0]).toEqual({
      name: 'deepfreeze-000011-thawed',
      policy: {
        phases: {
          delete: {
            min_age: '29d',
            actions: { delete: { delete_searchable_snapshot: true } },
          },
        },
      },
    });
  });

  it('is idempotent when the policy already exists', async () => {
    const { client, trace } = makeClient();
    const name = await ensureThawedIlmPolicy(client, 'deepfreeze-000011');

    expect(name).toBe('deepfreeze-000011-thawed');
    expect(trace.ilm_put_calls).toEqual([]);
  });
});

describe('assignIlmPolicy', () => {
  it('removes any existing policy and puts the new one via put_settings', async () => {
    const { client, trace } = makeClient();
    await assignIlmPolicy(client, 'logs-2026.05.23', 'deepfreeze-000011-thawed');

    expect(trace.ilm_remove_calls).toEqual([{ index: 'logs-2026.05.23' }]);
    expect(trace.put_settings_calls).toEqual([
      {
        index: 'logs-2026.05.23',
        body: { 'index.lifecycle.name': 'deepfreeze-000011-thawed' },
      },
    ]);
  });

  it("tolerates 'no existing policy' on the remove step", async () => {
    const { client, trace } = makeClient({ failIlmRemove: true });
    // Should not throw; the put_settings still runs.
    await assignIlmPolicy(client, 'logs-2026.05.23', 'p');
    expect(trace.put_settings_calls).toHaveLength(1);
  });
});

describe('mountSnapshotIndex', () => {
  it('skips the mount call when the index already exists', async () => {
    const { client, trace } = makeClient({
      existingIndices: new Set(['logs-2026.05.23']),
    });
    const out = await mountSnapshotIndex(
      client,
      {
        repo: 'r',
        snapshot: 's',
        indexNameInSnapshot: 'logs-2026.05.23',
        mountedName: 'logs-2026.05.23',
      },
      noopLog
    );
    expect(out).toEqual({ mounted: true, alreadyMounted: true });
    expect(trace.mount_calls).toEqual([]);
  });

  it('mounts and includes renamed_index when names differ (fm-clone case)', async () => {
    const { client, trace } = makeClient();
    const out = await mountSnapshotIndex(
      client,
      {
        repo: 'r',
        snapshot: 's',
        indexNameInSnapshot: 'fm-clone-abc-logs',
        mountedName: 'logs',
      },
      noopLog
    );
    expect(out).toEqual({ mounted: true, alreadyMounted: false });
    expect(trace.mount_calls).toEqual([
      {
        repository: 'r',
        snapshot: 's',
        body: { index: 'fm-clone-abc-logs', renamed_index: 'logs' },
      },
    ]);
  });

  it('omits renamed_index when source and target names match', async () => {
    const { client, trace } = makeClient();
    await mountSnapshotIndex(
      client,
      {
        repo: 'r',
        snapshot: 's',
        indexNameInSnapshot: 'logs',
        mountedName: 'logs',
      },
      noopLog
    );
    expect(trace.mount_calls[0].body).toEqual({ index: 'logs' });
  });

  it('returns mounted=false on mount failure (no throw)', async () => {
    const { client } = makeClient({
      failMountForNames: new Set(['logs']),
    });
    const out = await mountSnapshotIndex(
      client,
      {
        repo: 'r',
        snapshot: 's',
        indexNameInSnapshot: 'logs',
        mountedName: 'logs',
      },
      noopLog
    );
    expect(out).toEqual({ mounted: false, alreadyMounted: false });
  });
});
