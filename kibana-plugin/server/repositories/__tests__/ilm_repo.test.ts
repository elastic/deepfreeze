import {
  getDeepfreezeIlmPolicies,
  type IlmRepoEsClient,
} from '../ilm_repo';

function makeClient(lifecycle: Record<string, unknown>): IlmRepoEsClient {
  return {
    ilm: {
      get_lifecycle: async () => lifecycle,
    },
  };
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
