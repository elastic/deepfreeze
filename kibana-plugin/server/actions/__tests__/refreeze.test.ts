import {
  runRefreeze,
  runRefreezeDryRun,
  type RefreezeActionEsClient,
} from '../refreeze';
import { ActionError, MissingSettingsError } from '../../errors';
import { SETTINGS_DEFAULTS, type SettingsDoc } from '../../../common/schemas/settings';
import { DOCTYPE, SETTINGS_ID, STATUS_INDEX } from '../../../common/constants';
import type { RepositoryDoc } from '../../../common/schemas/repository';
import type { ThawRequestDoc } from '../../../common/schemas/thaw_request';

interface FakeOpts {
  settings?: SettingsDoc | null;
  repos?: RepositoryDoc[];
  thawRequests?: ThawRequestDoc[];
  /**
   * Live indices keyed by name, with optional `store.snapshot.repository_name`
   * to mark them as searchable-snapshot backed.
   */
  indices?: Record<string, { repository_name?: string }>;
  dataStreams?: Array<{ name: string; backing: string[] }>;
  failDeleteIndices?: string[];
}

interface Trace {
  deleted_indices: string[];
  deleted_data_streams: string[];
  detached_from_data_stream: Array<{ data_stream: string; index: string }>;
  deleted_repos: string[];
  index_calls: Array<{ index: string; id: string; document: Record<string, unknown> }>;
}

function makeClient(opts: FakeOpts = {}): { client: RefreezeActionEsClient; trace: Trace } {
  const trace: Trace = {
    deleted_indices: [],
    deleted_data_streams: [],
    detached_from_data_stream: [],
    deleted_repos: [],
    index_calls: [],
  };

  const liveIndices = new Set(Object.keys(opts.indices ?? {}));
  // Mutable view of the data streams so detach actions can be reflected
  // on subsequent calls (matches ES behavior). Kept in scope for the
  // lifetime of this client.
  const dataStreams = (opts.dataStreams ?? []).map((ds) => ({
    name: ds.name,
    backing: [...ds.backing],
  }));

  const client: RefreezeActionEsClient = {
    indices: {
      exists: async ({ index }) => index === STATUS_INDEX || liveIndices.has(index),
      getSettings: async () => {
        const out: Record<string, unknown> = {};
        for (const [name, cfg] of Object.entries(opts.indices ?? {})) {
          out[name] = {
            settings: {
              index: {
                store: cfg.repository_name
                  ? { type: 'snapshot', snapshot: { repository_name: cfg.repository_name } }
                  : {},
              },
            },
          };
        }
        return out;
      },
      getDataStream: async () => ({
        data_streams: dataStreams.map((ds) => ({
          name: ds.name,
          indices: ds.backing.map((b) => ({ index_name: b })),
        })),
      }),
      delete: async ({ index }) => {
        if (opts.failDeleteIndices?.includes(index)) throw new Error('boom-' + index);
        trace.deleted_indices.push(index);
        liveIndices.delete(index);
        return {};
      },
      modifyDataStream: async ({ body }) => {
        for (const action of body.actions ?? []) {
          if (action.remove_backing_index) {
            const { data_stream, index } = action.remove_backing_index;
            trace.detached_from_data_stream.push({ data_stream, index });
            // Reflect the detach in the in-memory view so a subsequent
            // `getDataStream` would no longer report this index.
            const ds = dataStreams.find((d) => d.name === data_stream);
            if (ds) ds.backing = ds.backing.filter((b) => b !== index);
          }
        }
        return {};
      },
    } as RefreezeActionEsClient['indices'],
    get: async ({ id }) => {
      if (id === SETTINGS_ID) {
        if (opts.settings === null) return { found: false };
        return { _source: opts.settings ?? SETTINGS_DEFAULTS, found: true };
      }
      return { found: false };
    },
    search: async (params) => {
      const query = params.query as
        | { match?: { doctype?: string }; term?: { doctype?: string; request_id?: string } }
        | undefined;
      const dt = query?.match?.doctype ?? query?.term?.doctype;
      const reqId = query?.term?.request_id;
      if (reqId) {
        const r = (opts.thawRequests ?? []).find((t) => t.request_id === reqId);
        return {
          hits: { hits: r ? [{ _id: r.request_id, _source: r as unknown as Record<string, unknown> }] : [] },
        };
      }
      if (dt === DOCTYPE.repository) {
        return {
          hits: {
            hits: (opts.repos ?? []).map((r) => ({
              _id: r.name,
              _source: r as unknown as Record<string, unknown>,
            })),
          },
        };
      }
      if (dt === DOCTYPE.thaw_request) {
        return {
          hits: {
            hits: (opts.thawRequests ?? []).map((t) => ({
              _id: t.request_id,
              _source: t as unknown as Record<string, unknown>,
            })),
          },
        };
      }
      return { hits: { hits: [] } };
    },
    index: async (args) => {
      trace.index_calls.push(args);
      return {};
    },
    delete: async () => ({}),
    snapshot: {
      getRepository: async () => ({}),
      createRepository: async () => ({}),
      deleteRepository: async ({ name }) => {
        trace.deleted_repos.push(name);
        return {};
      },
    },
    ilm: {
      getLifecycle: async () => ({}),
      putLifecycle: async () => ({}),
    },
  };

  return { client, trace };
}

function repoDoc(name: string, overrides: Partial<RepositoryDoc> = {}): RepositoryDoc {
  return {
    doctype: 'repository',
    name,
    bucket: 'b',
    base_path: 'p',
    start: null,
    end: null,
    is_thawed: true,
    is_mounted: true,
    thaw_state: 'thawed',
    thawed_at: '2026-05-01T00:00:00Z',
    expires_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

function thawReq(
  id: string,
  status: ThawRequestDoc['status'],
  repos: string[]
): ThawRequestDoc {
  return {
    doctype: 'thaw_request',
    request_id: id,
    repos,
    status,
    created_at: '2026-05-01T00:00:00Z',
  };
}

// -- Preconditions / arg validation ---------------------------------------

describe('runRefreeze argument validation', () => {
  it('rejects calls with neither request_id nor all_requests', async () => {
    const { client } = makeClient();
    await expect(runRefreeze(client, {})).rejects.toBeInstanceOf(ActionError);
  });

  it('rejects calls with both', async () => {
    const { client } = makeClient();
    await expect(runRefreeze(client, { request_id: 'x', all_requests: true })).rejects.toBeInstanceOf(
      ActionError
    );
  });

  it('throws MissingSettingsError on uninitialized cluster', async () => {
    const { client } = makeClient({ settings: null });
    await expect(runRefreeze(client, { request_id: 'x' })).rejects.toBeInstanceOf(
      MissingSettingsError
    );
  });
});

// -- Dry-run ---------------------------------------------------------------

describe('runRefreezeDryRun', () => {
  it('reports the target request without making any changes', async () => {
    const { client, trace } = makeClient({
      thawRequests: [thawReq('r-1', 'completed', ['deepfreeze-000005'])],
      repos: [repoDoc('deepfreeze-000005')],
    });

    const result = await runRefreezeDryRun(client, { request_id: 'r-1' });
    expect(result.dry_run).toBe(true);
    expect(result.refrozen_requests).toEqual(['r-1']);
    expect(trace.deleted_indices).toEqual([]);
    expect(trace.deleted_data_streams).toEqual([]);
    expect(trace.deleted_repos).toEqual([]);
    expect(trace.index_calls).toEqual([]);
  });

  it('rejects requests whose status is not completed', async () => {
    const { client } = makeClient({
      thawRequests: [thawReq('r-1', 'refrozen', ['deepfreeze-000005'])],
    });
    const result = await runRefreezeDryRun(client, { request_id: 'r-1' });
    expect(result.refrozen_requests).toEqual([]);
    expect(result.rejected_requests).toEqual([{ request_id: 'r-1', reason: 'already refrozen' }]);
  });

  it('reports request_not_found when the request_id is unknown', async () => {
    const { client } = makeClient({});
    const result = await runRefreezeDryRun(client, { request_id: 'missing' });
    expect(result.rejected_requests).toEqual([{ request_id: 'missing', reason: 'not found' }]);
  });

  it('with all_requests, picks every completed thaw request', async () => {
    const { client } = makeClient({
      thawRequests: [
        thawReq('a', 'completed', ['deepfreeze-000001']),
        thawReq('b', 'completed', ['deepfreeze-000002']),
        thawReq('c', 'failed', ['deepfreeze-000003']),
        thawReq('d', 'refrozen', ['deepfreeze-000004']),
      ],
      repos: [
        repoDoc('deepfreeze-000001'),
        repoDoc('deepfreeze-000002'),
      ],
    });
    const result = await runRefreezeDryRun(client, { all_requests: true });
    expect(result.refrozen_requests.sort()).toEqual(['a', 'b']);
  });
});

// -- Full run -------------------------------------------------------------

describe('runRefreeze happy path', () => {
  it('deletes searchable-snapshot indices, unmounts the repo, and flips state to frozen', async () => {
    const { client, trace } = makeClient({
      thawRequests: [thawReq('r-1', 'completed', ['deepfreeze-000005'])],
      repos: [repoDoc('deepfreeze-000005')],
      indices: {
        'restored-logs-2026-04-01': { repository_name: 'deepfreeze-000005' },
        'restored-logs-2026-04-02': { repository_name: 'deepfreeze-000005' },
        'unrelated-index': { repository_name: 'other-repo' },
      },
    });

    const result = await runRefreeze(client, { request_id: 'r-1' });

    expect(result.success).toBe(true);
    expect(result.refrozen_requests).toEqual(['r-1']);
    expect(trace.deleted_indices.sort()).toEqual([
      'restored-logs-2026-04-01',
      'restored-logs-2026-04-02',
    ]);
    expect(trace.deleted_repos).toEqual(['deepfreeze-000005']);

    // RepositoryDoc + ThawRequestDoc both got rewritten
    const repoDocSave = trace.index_calls
      .map((c) => c.document as Record<string, unknown>)
      .find((d) => d.doctype === 'repository' && d.name === 'deepfreeze-000005');
    expect(repoDocSave).toMatchObject({
      is_thawed: false,
      is_mounted: false,
      thaw_state: 'frozen',
      thawed_at: null,
      expires_at: null,
    });

    const thawDocSave = trace.index_calls
      .map((c) => c.document as Record<string, unknown>)
      .find((d) => d.doctype === 'thaw_request' && d.request_id === 'r-1');
    expect(thawDocSave).toMatchObject({ status: 'refrozen' });
  });

  it('detaches data-stream backing indices before deleting them; never deletes the data stream itself', async () => {
    // Critical safety property: `logs` data stream has both a thawed
    // backing index (.ds-logs-001) AND active hot backings
    // (.ds-logs-002, .ds-logs-003). Refreezing the thawed one must
    // surgically detach + delete just .ds-logs-001 — the data stream
    // and its other backings must survive untouched. Whole-stream
    // delete would destroy the operator's hot data.
    const { client, trace } = makeClient({
      thawRequests: [thawReq('r-1', 'completed', ['deepfreeze-000005'])],
      repos: [repoDoc('deepfreeze-000005')],
      indices: {
        '.ds-logs-001': { repository_name: 'deepfreeze-000005' },
        'standalone': { repository_name: 'deepfreeze-000005' },
      },
      dataStreams: [
        {
          name: 'logs',
          backing: ['.ds-logs-001', '.ds-logs-002', '.ds-logs-003'],
        },
      ],
    });

    await runRefreeze(client, { request_id: 'r-1' });

    // The backing index was detached, then deleted.
    expect(trace.detached_from_data_stream).toEqual([
      { data_stream: 'logs', index: '.ds-logs-001' },
    ]);
    expect(trace.deleted_indices.sort()).toEqual(['.ds-logs-001', 'standalone']);
    // No data stream destruction.
    expect(trace.deleted_data_streams).toEqual([]);
    expect(trace.deleted_repos).toEqual(['deepfreeze-000005']);
  });

  it('records per-index delete failures as step skips but still proceeds with the repo', async () => {
    // The Python parent action takes the same posture: index-level failures
    // are warnings. In production, an index that can't be deleted would
    // typically cause the cascading snapshot.deleteRepository call to fail
    // (ES rejects DELETE _snapshot when indices reference it), which IS
    // surfaced as a per-repo outcome.error. The mock here doesn't simulate
    // that cascade, so we just verify the warning is captured.
    const { client } = makeClient({
      thawRequests: [thawReq('r-1', 'completed', ['deepfreeze-000005'])],
      repos: [repoDoc('deepfreeze-000005')],
      indices: { broken: { repository_name: 'deepfreeze-000005' } },
      failDeleteIndices: ['broken'],
    });

    const result = await runRefreeze(client, { request_id: 'r-1' });
    expect(
      result.steps.some((s) => s.type === 'index' && s.action === 'skipped' && s.name === 'broken')
    ).toBe(true);
  });

  it('passes expand_wildcards=all to getSettings so hidden .ds-* indices are visible', async () => {
    // Regression for the silent-no-op trap: .ds-* data-stream backing
    // indices are hidden by default, and a bare `*` wildcard misses
    // them. Without expand_wildcards: 'all', refreeze would find zero
    // SS indices to tear down, breeze past the (empty) loop, call
    // deleteSnapshotRepository, and ES would reject with
    // repository_conflict_exception. The fix is in the request shape;
    // verify it actually travels on the wire.
    const repo = repoDoc('deepfreeze-000005');
    const { client } = makeClient({
      thawRequests: [thawReq('r-1', 'completed', [repo.name])],
      repos: [repo],
    });
    let capturedGetSettings: {
      index: string;
      expand_wildcards?: string;
    } | null = null;
    const orig = client.indices.getSettings;
    client.indices.getSettings = async (params) => {
      capturedGetSettings = params;
      return orig(params);
    };

    await runRefreeze(client, { request_id: 'r-1' });

    expect(capturedGetSettings).toMatchObject({
      index: '*',
      expand_wildcards: 'all',
    });
  });

  it('records a warning when a thaw request references a repo that is not in the status index', async () => {
    const { client } = makeClient({
      thawRequests: [thawReq('r-1', 'completed', ['ghost-repo'])],
      repos: [],
    });

    const result = await runRefreeze(client, { request_id: 'r-1' });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ target: 'ghost-repo', severity: 'warning' });
    expect(result.refrozen_requests).toEqual([]);
    // And — the rejection slot carries a specific reason so the UI
    // toast doesn't have to fall back to "unknown reason".
    expect(result.rejected_requests).toEqual([
      { request_id: 'r-1', reason: expect.stringContaining('ghost-repo') },
    ]);
  });

  it('populates rejected_requests with the per-repo error detail when a repo fails to refreeze', async () => {
    // Repo doc exists, but one of its searchable_snapshot indices can't
    // be deleted — that bubbles up to `outcome.error` inside
    // refreezeOneRepo, which then propagates to the cascade
    // `snapshot.deleteRepository` step. Either way: allRepoOk goes
    // false, and rejected_requests must carry the reason.
    const repo = repoDoc('deepfreeze-000005');
    const { client } = makeClient({
      thawRequests: [thawReq('r-1', 'completed', [repo.name])],
      repos: [repo],
      // No live indices, so refreezeOneRepo's index-listing finds
      // nothing to delete; the repo unmount then runs. To force a real
      // failure, override deleteRepository on the returned client.
    });
    client.snapshot.deleteRepository = async () => {
      throw new Error('repo busy: has active searchable_snapshot indices');
    };

    const result = await runRefreeze(client, { request_id: 'r-1' });

    expect(result.refrozen_requests).toEqual([]);
    expect(result.rejected_requests).toEqual([
      {
        request_id: 'r-1',
        reason: expect.stringMatching(/deepfreeze-000005.*repo busy/),
      },
    ]);
  });
});
