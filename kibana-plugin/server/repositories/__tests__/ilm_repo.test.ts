import {
  createVersionedIlmPolicy,
  deleteIlmPolicy,
  getDeepfreezeIlmPolicies,
  getIlmPolicy,
  isPolicySafeToDelete,
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

describe('createVersionedIlmPolicy', () => {
  function writeClient(): {
    client: IlmRepoWriteEsClient;
    puts: Array<{ name: string; policy: Record<string, unknown> }>;
  } {
    const puts: Array<{ name: string; policy: Record<string, unknown> }> = [];
    const client: IlmRepoWriteEsClient = {
      ilm: {
        getLifecycle: async () => {
          throw notFound();
        },
        putLifecycle: async (args) => {
          puts.push(args);
          return {};
        },
      },
    };
    return { client, puts };
  }

  it('writes <base>-<suffix> with searchable_snapshot.snapshot_repository retargeted', async () => {
    const { client, puts } = writeClient();
    const baseBody = {
      phases: {
        hot: { min_age: '0ms', actions: { rollover: { max_size: '50gb' } } },
        frozen: {
          min_age: '30d',
          actions: { searchable_snapshot: { snapshot_repository: 'old-repo' } },
        },
      },
    };

    const name = await createVersionedIlmPolicy(
      client,
      'logs-policy',
      baseBody,
      'deepfreeze-000002',
      '000002'
    );

    expect(name).toBe('logs-policy-000002');
    expect(puts).toHaveLength(1);
    expect(puts[0].name).toBe('logs-policy-000002');
    const policy = puts[0].policy as {
      phases: {
        hot: { actions: { rollover: { max_size: string } } };
        frozen: { actions: { searchable_snapshot: { snapshot_repository: string } } };
      };
    };
    // Frozen phase repointed.
    expect(policy.phases.frozen.actions.searchable_snapshot.snapshot_repository).toBe(
      'deepfreeze-000002'
    );
    // Non-searchable_snapshot fields preserved.
    expect(policy.phases.hot.actions.rollover.max_size).toBe('50gb');
  });

  it('does not mutate the input body (deep clone)', async () => {
    const { client } = writeClient();
    const baseBody = {
      phases: {
        frozen: {
          actions: { searchable_snapshot: { snapshot_repository: 'old-repo' } },
        },
      },
    };
    await createVersionedIlmPolicy(client, 'p', baseBody, 'new-repo', '000003');
    // The caller's copy of baseBody should still reference the OLD repo.
    expect(
      baseBody.phases.frozen.actions.searchable_snapshot.snapshot_repository
    ).toBe('old-repo');
  });

  it('handles bodies with multiple phases referencing snapshot_repository', async () => {
    const { client, puts } = writeClient();
    const baseBody = {
      phases: {
        cold: {
          actions: { searchable_snapshot: { snapshot_repository: 'old-repo' } },
        },
        frozen: {
          actions: { searchable_snapshot: { snapshot_repository: 'old-repo' } },
        },
      },
    };
    await createVersionedIlmPolicy(client, 'p', baseBody, 'new-repo', '000004');
    const policy = puts[0].policy as {
      phases: Record<
        string,
        { actions: { searchable_snapshot: { snapshot_repository: string } } }
      >;
    };
    expect(policy.phases.cold.actions.searchable_snapshot.snapshot_repository).toBe('new-repo');
    expect(policy.phases.frozen.actions.searchable_snapshot.snapshot_repository).toBe('new-repo');
  });
});

describe('isPolicySafeToDelete', () => {
  function readClient(opts: {
    policies?: Record<
      string,
      {
        policy?: { phases?: Record<string, unknown> };
        in_use_by?: {
          indices?: unknown[];
          data_streams?: unknown[];
          composable_templates?: unknown[];
        };
      }
    >;
  }): IlmRepoEsClient {
    return {
      ilm: {
        getLifecycle: async ({ name }: { name?: string } = {}) => {
          if (!name) return opts.policies ?? {};
          const p = opts.policies?.[name];
          if (!p) throw notFound();
          return { [name]: p };
        },
      },
    };
  }

  it('returns true when in_use_by counts are all zero', async () => {
    const client = readClient({
      policies: {
        p: { in_use_by: { indices: [], data_streams: [], composable_templates: [] } },
      },
    });
    expect(await isPolicySafeToDelete(client, 'p')).toBe(true);
  });

  it('returns false when any index references the policy', async () => {
    const client = readClient({
      policies: {
        p: { in_use_by: { indices: ['idx-1'], data_streams: [], composable_templates: [] } },
      },
    });
    expect(await isPolicySafeToDelete(client, 'p')).toBe(false);
  });

  it('returns false when any data stream references the policy', async () => {
    const client = readClient({
      policies: {
        p: { in_use_by: { indices: [], data_streams: ['logs'], composable_templates: [] } },
      },
    });
    expect(await isPolicySafeToDelete(client, 'p')).toBe(false);
  });

  it('returns false when any composable template references the policy', async () => {
    const client = readClient({
      policies: {
        p: { in_use_by: { indices: [], data_streams: [], composable_templates: ['t'] } },
      },
    });
    expect(await isPolicySafeToDelete(client, 'p')).toBe(false);
  });

  it('returns false for a missing policy (defensive)', async () => {
    const client = readClient({});
    expect(await isPolicySafeToDelete(client, 'missing')).toBe(false);
  });

  it('treats absent in_use_by as zero references (older ES responses)', async () => {
    const client = readClient({ policies: { p: {} } });
    expect(await isPolicySafeToDelete(client, 'p')).toBe(true);
  });
});

describe('deleteIlmPolicy', () => {
  function writeClient(opts: { throwStatus?: number } = {}): {
    client: IlmRepoWriteEsClient;
    deletes: string[];
  } {
    const deletes: string[] = [];
    const client: IlmRepoWriteEsClient = {
      ilm: {
        getLifecycle: async () => ({}),
        putLifecycle: async () => ({}),
        deleteLifecycle: async ({ name }: { name: string }) => {
          if (opts.throwStatus !== undefined) {
            const err = new Error('boom') as Error & {
              statusCode?: number;
              meta?: { statusCode?: number };
            };
            err.statusCode = opts.throwStatus;
            err.meta = { statusCode: opts.throwStatus };
            throw err;
          }
          deletes.push(name);
          return {};
        },
      },
    };
    return { client, deletes };
  }

  it('issues a delete call for the named policy', async () => {
    const { client, deletes } = writeClient();
    await deleteIlmPolicy(client, 'my-policy');
    expect(deletes).toEqual(['my-policy']);
  });

  it('swallows 404 (idempotent)', async () => {
    const { client, deletes } = writeClient({ throwStatus: 404 });
    await expect(deleteIlmPolicy(client, 'gone')).resolves.toBeUndefined();
    expect(deletes).toEqual([]);
  });

  it('propagates non-404 errors', async () => {
    const { client } = writeClient({ throwStatus: 500 });
    await expect(deleteIlmPolicy(client, 'p')).rejects.toThrow();
  });
});
