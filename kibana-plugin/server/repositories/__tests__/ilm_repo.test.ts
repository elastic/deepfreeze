import {
  createOrUpdateIlmPolicy,
  defaultIlmPolicyBody,
  getDeepfreezeIlmPolicies,
  getIlmPolicy,
  type IlmRepoEsClient,
  type IlmRepoWriteEsClient,
} from '../ilm_repo';

function makeClient(lifecycle: Record<string, unknown>): IlmRepoEsClient {
  return {
    ilm: {
      getLifecycle: async () => lifecycle,
    },
  };
}

function notFound(): Error {
  const e: Error & { statusCode?: number; meta?: { statusCode: number } } = new Error('nf');
  e.statusCode = 404;
  e.meta = { statusCode: 404 };
  return e;
}

describe('getDeepfreezeIlmPolicies', () => {
  it('returns policies whose searchable_snapshot phase points at a deepfreeze repo', async () => {
    const client = makeClient({
      'cold-policy': {
        policy: {
          phases: {
            cold: {
              actions: {
                searchable_snapshot: {
                  snapshot_repository: 'deepfreeze-000001',
                },
              },
            },
          },
        },
        in_use_by: {
          indices: ['logs-2026-04-01', 'logs-2026-04-02'],
          data_streams: ['logs'],
          composable_templates: [],
        },
      },
      'unrelated-policy': {
        policy: {
          phases: {
            cold: {
              actions: {
                searchable_snapshot: {
                  snapshot_repository: 'archive-other',
                },
              },
            },
          },
        },
        in_use_by: {},
      },
    });

    const policies = await getDeepfreezeIlmPolicies(client, 'deepfreeze');

    expect(policies).toHaveLength(1);
    expect(policies[0]).toEqual({
      name: 'cold-policy',
      repository: 'deepfreeze-000001',
      indices_count: 2,
      data_streams_count: 1,
      templates_count: 0,
    });
  });

  it('contributes at most one row per policy even when multiple phases match', async () => {
    const client = makeClient({
      'multi-phase-policy': {
        policy: {
          phases: {
            cold: {
              actions: {
                searchable_snapshot: { snapshot_repository: 'deepfreeze-001' },
              },
            },
            frozen: {
              actions: {
                searchable_snapshot: { snapshot_repository: 'deepfreeze-002' },
              },
            },
          },
        },
        in_use_by: {},
      },
    });

    const policies = await getDeepfreezeIlmPolicies(client, 'deepfreeze');

    expect(policies).toHaveLength(1);
    // First matching phase wins (object iteration order)
    expect(policies[0].repository).toBe('deepfreeze-001');
  });

  it('returns [] when no policies match the prefix', async () => {
    const client = makeClient({
      'cold-policy': {
        policy: {
          phases: {
            cold: {
              actions: {
                searchable_snapshot: { snapshot_repository: 'other-repo' },
              },
            },
          },
        },
      },
    });

    await expect(getDeepfreezeIlmPolicies(client, 'deepfreeze')).resolves.toEqual([]);
  });

  it('skips policies with no searchable_snapshot action', async () => {
    const client = makeClient({
      'hot-only-policy': {
        policy: {
          phases: {
            hot: { actions: { rollover: { max_age: '30d' } } },
          },
        },
        in_use_by: {},
      },
    });

    await expect(getDeepfreezeIlmPolicies(client, 'deepfreeze')).resolves.toEqual([]);
  });

  it('handles missing in_use_by gracefully (counts default to 0)', async () => {
    const client = makeClient({
      'cold-policy': {
        policy: {
          phases: {
            cold: {
              actions: {
                searchable_snapshot: { snapshot_repository: 'deepfreeze-1' },
              },
            },
          },
        },
        // in_use_by intentionally omitted
      },
    });

    const policies = await getDeepfreezeIlmPolicies(client, 'deepfreeze');

    expect(policies[0]).toMatchObject({
      indices_count: 0,
      data_streams_count: 0,
      templates_count: 0,
    });
  });
});

describe('getIlmPolicy', () => {
  it('returns the policy when present', async () => {
    const client: IlmRepoEsClient = {
      ilm: {
        getLifecycle: async ({ name }: { name?: string } = {}) => ({
          [name!]: { policy: { phases: {} } },
        }),
      },
    };
    expect(await getIlmPolicy(client, 'p')).toEqual({ policy: { phases: {} } });
  });

  it('returns null on 404', async () => {
    const client: IlmRepoEsClient = {
      ilm: {
        getLifecycle: async () => {
          throw notFound();
        },
      },
    };
    expect(await getIlmPolicy(client, 'p')).toBeNull();
  });
});

describe('createOrUpdateIlmPolicy', () => {
  function writeClient(opts: {
    existing?: Record<string, unknown>;
    captureKey?: (args: { name: string; policy: Record<string, unknown> }) => void;
  } = {}): IlmRepoWriteEsClient {
    return {
      ilm: {
        getLifecycle: async ({ name }: { name?: string } = {}) => {
          if (!opts.existing) throw notFound();
          return { [name!]: opts.existing };
        },
        putLifecycle: async (args) => {
          opts.captureKey?.(args);
          return {};
        },
      },
    };
  }

  it('creates the default policy body when the named policy does not exist', async () => {
    const captured: Array<{ name: string; policy: Record<string, unknown> }> = [];
    const client = writeClient({ captureKey: (a) => captured.push(a) });

    const result = await createOrUpdateIlmPolicy(client, 'new-policy', 'deepfreeze-000001');

    expect(result.action).toBe('created');
    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({
      name: 'new-policy',
      policy: defaultIlmPolicyBody('deepfreeze-000001'),
    });
  });

  it('rewrites searchable_snapshot.snapshot_repository to the new repo when an existing policy differs', async () => {
    const captured: Array<{ name: string; policy: Record<string, unknown> }> = [];
    const client = writeClient({
      existing: {
        policy: {
          phases: {
            frozen: {
              actions: { searchable_snapshot: { snapshot_repository: 'old-repo' } },
            },
            delete: {
              actions: { delete: { delete_searchable_snapshot: true } },
            },
          },
        },
      },
      captureKey: (a) => captured.push(a),
    });

    const result = await createOrUpdateIlmPolicy(client, 'p', 'new-repo');
    expect(result.action).toBe('updated');

    const phases = (captured[0].policy as { policy: { phases: Record<string, unknown> } }).policy
      .phases;
    expect(
      (phases.frozen as { actions: { searchable_snapshot: { snapshot_repository: string } } })
        .actions.searchable_snapshot.snapshot_repository
    ).toBe('new-repo');
    expect(
      (phases.delete as { actions: { delete: { delete_searchable_snapshot: boolean } } }).actions
        .delete.delete_searchable_snapshot
    ).toBe(false);
  });

  it('returns unchanged + skips PUT when nothing differs', async () => {
    const captured: Array<{ name: string; policy: Record<string, unknown> }> = [];
    const client = writeClient({
      existing: {
        policy: {
          phases: {
            frozen: {
              actions: { searchable_snapshot: { snapshot_repository: 'new-repo' } },
            },
            delete: {
              actions: { delete: { delete_searchable_snapshot: false } },
            },
          },
        },
      },
      captureKey: (a) => captured.push(a),
    });

    const result = await createOrUpdateIlmPolicy(client, 'p', 'new-repo');
    expect(result.action).toBe('unchanged');
    expect(captured).toHaveLength(0);
  });
});
