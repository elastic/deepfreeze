import {
  addIndexToDatastream,
  assignIlmPolicy,
  ensureThawedIlmPolicy,
  findLatestSnapshotForIndex,
  getAllIndicesInRepo,
  mountSnapshotIndex,
  parseDataStreamFromIndexName,
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
  /** Set of data stream names that `indices.getDataStream` reports as existing. When undefined, ALL streams exist. */
  existingDataStreams?: Set<string>;
  /** Throw on `indices.modifyDataStream`. */
  failModifyDataStream?: boolean;
}

interface Trace {
  mount_calls: Array<{ repository: string; snapshot: string; body: { index: string; renamed_index?: string } }>;
  ilm_get_calls: Array<{ name?: string }>;
  ilm_put_calls: Array<{ name: string; policy: Record<string, unknown> }>;
  ilm_remove_calls: Array<{ index: string }>;
  put_settings_calls: Array<{ index: string; body: Record<string, unknown> }>;
  delete_index_calls: string[];
  get_data_stream_calls: string[];
  modify_data_stream_calls: Array<{ body: { actions: Array<Record<string, unknown>> } }>;
}

function makeClient(opts: FakeOpts = {}): { client: SearchableSnapshotEsClient; trace: Trace } {
  const trace: Trace = {
    mount_calls: [],
    ilm_get_calls: [],
    ilm_put_calls: [],
    ilm_remove_calls: [],
    put_settings_calls: [],
    delete_index_calls: [],
    get_data_stream_calls: [],
    modify_data_stream_calls: [],
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
      getDataStream: async ({ name }) => {
        trace.get_data_stream_calls.push(name);
        if (opts.existingDataStreams && !opts.existingDataStreams.has(name)) {
          const err = new Error('not found') as Error & { statusCode?: number };
          err.statusCode = 404;
          throw err;
        }
        return {};
      },
      modifyDataStream: async (params) => {
        trace.modify_data_stream_calls.push(params);
        if (opts.failModifyDataStream) {
          throw new Error('modify failed');
        }
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
  it('creates a cold-at-0ms + delete-at-29d policy with delete_searchable_snapshot=false', async () => {
    const { client, trace } = makeClient({ ilmGetLifecycleNotFound: true });
    const name = await ensureThawedIlmPolicy(client, 'deepfreeze-000011');

    expect(name).toBe('deepfreeze-000011-thawed');
    expect(trace.ilm_put_calls).toHaveLength(1);
    expect(trace.ilm_put_calls[0]).toEqual({
      name: 'deepfreeze-000011-thawed',
      policy: {
        phases: {
          cold: {
            min_age: '0ms',
            actions: { set_priority: { priority: 0 } },
          },
          delete: {
            min_age: '29d',
            actions: { delete: { delete_searchable_snapshot: false } },
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

describe('parseDataStreamFromIndexName', () => {
  it('returns null for names that do not start with .ds-', () => {
    expect(parseDataStreamFromIndexName('logs-2026.05.23')).toBeNull();
    expect(parseDataStreamFromIndexName('metrics-2026.05.23-000001')).toBeNull();
  });

  it('extracts the ds-name from a canonical backing-index name', () => {
    expect(parseDataStreamFromIndexName('.ds-logs-2026.05.23-000001')).toBe('logs');
  });

  it('handles ds-names that themselves contain hyphens', () => {
    expect(parseDataStreamFromIndexName('.ds-df-test-2026.05.25-000001')).toBe(
      'df-test'
    );
    expect(
      parseDataStreamFromIndexName('.ds-some-app-logs-2026.05.23-000017')
    ).toBe('some-app-logs');
  });

  it('returns null when the name is too short to parse', () => {
    expect(parseDataStreamFromIndexName('.ds-only-one')).toBeNull();
    expect(parseDataStreamFromIndexName('.ds-')).toBeNull();
  });
});

describe('addIndexToDatastream', () => {
  it('issues a modify_data_stream add_backing_index action on success', async () => {
    const { client, trace } = makeClient();
    const ok = await addIndexToDatastream(
      client,
      'df-test',
      '.ds-df-test-2026.05.25-000001',
      noopLog
    );
    expect(ok).toBe(true);
    expect(trace.get_data_stream_calls).toEqual(['df-test']);
    expect(trace.modify_data_stream_calls).toEqual([
      {
        body: {
          actions: [
            {
              add_backing_index: {
                data_stream: 'df-test',
                index: '.ds-df-test-2026.05.25-000001',
              },
            },
          ],
        },
      },
    ]);
  });

  it('returns false (no-op) when the data stream does not exist', async () => {
    const { client, trace } = makeClient({
      existingDataStreams: new Set(['other-stream']),
    });
    const ok = await addIndexToDatastream(
      client,
      'df-test',
      '.ds-df-test-2026.05.25-000001',
      noopLog
    );
    expect(ok).toBe(false);
    // No modify call attempted when the stream is absent.
    expect(trace.modify_data_stream_calls).toEqual([]);
  });

  it('returns false when modify_data_stream throws', async () => {
    const { client, trace } = makeClient({ failModifyDataStream: true });
    const ok = await addIndexToDatastream(
      client,
      'df-test',
      '.ds-df-test-2026.05.25-000001',
      noopLog
    );
    expect(ok).toBe(false);
    // The modify call WAS attempted (the stream lookup succeeded).
    expect(trace.modify_data_stream_calls).toHaveLength(1);
  });
});
