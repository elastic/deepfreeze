import { runStatus, type StatusActionEsClient } from '../status';
import { SETTINGS_DEFAULTS } from '../../../common/schemas/settings';
import { DOCTYPE, SETTINGS_ID, STATUS_INDEX } from '../../../common/constants';

interface FakeOpts {
  indexExists?: boolean;
  settingsDoc?: Record<string, unknown> | null;
  repoHits?: Array<{ _id: string; _source: Record<string, unknown> }>;
  thawHits?: Array<{ _id: string; _source: Record<string, unknown> }>;
  snapshotRepos?: Record<string, unknown>;
  ilmPolicies?: Record<string, unknown>;
  clusterHealth?: {
    cluster_name?: string;
    status?: 'green' | 'yellow' | 'red';
    number_of_nodes?: number;
  };
  versionInfo?: { version?: { number?: string } };
  failSearch?: boolean;
  failIlm?: boolean;
  failCluster?: boolean;
}

function makeClient(opts: FakeOpts = {}): StatusActionEsClient {
  return {
    indices: {
      exists: async ({ index }) => {
        expect(index).toBe(STATUS_INDEX);
        return opts.indexExists ?? true;
      },
    },
    get: async ({ index, id }) => {
      expect(index).toBe(STATUS_INDEX);
      expect(id).toBe(SETTINGS_ID);
      if (opts.settingsDoc === null || opts.settingsDoc === undefined) {
        return { found: false };
      }
      return { _source: opts.settingsDoc, found: true };
    },
    search: async (params) => {
      if (opts.failSearch) {
        throw new Error('boom-search');
      }
      const query = params.query as { match?: { doctype?: string }; term?: { doctype?: string } };
      const docType = query.match?.doctype ?? query.term?.doctype;
      if (docType === DOCTYPE.repository) {
        return { hits: { hits: opts.repoHits ?? [] } };
      }
      if (docType === DOCTYPE.thaw_request) {
        return { hits: { hits: opts.thawHits ?? [] } };
      }
      return { hits: { hits: [] } };
    },
    snapshot: {
      getRepository: async () => opts.snapshotRepos ?? {},
    },
    ilm: {
      getLifecycle: async () => {
        if (opts.failIlm) {
          throw new Error('boom-ilm');
        }
        return opts.ilmPolicies ?? {};
      },
    },
    cluster: {
      health: async () => {
        if (opts.failCluster) {
          throw new Error('boom-cluster');
        }
        return opts.clusterHealth ?? {
          cluster_name: 'test-cluster',
          status: 'green',
          number_of_nodes: 1,
        };
      },
    },
    info: async () => opts.versionInfo ?? { version: { number: '9.4.2' } },
  };
}

describe('runStatus', () => {
  it('returns initialized:false with MISSING_INDEX when the status index is absent', async () => {
    const client = makeClient({ indexExists: false });

    const result = await runStatus(client);

    expect(result.initialized).toBe(false);
    expect(result.settings).toBeNull();
    expect(result.repositories).toEqual([]);
    expect(result.thaw_requests).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: 'MISSING_INDEX',
      severity: 'warning',
    });
  });

  it('returns initialized:false with MISSING_SETTINGS when the index exists but the doc is missing', async () => {
    const client = makeClient({ indexExists: true, settingsDoc: null });

    const result = await runStatus(client);

    expect(result.initialized).toBe(false);
    expect(result.settings).toBeNull();
    expect(result.errors[0]).toMatchObject({ code: 'MISSING_SETTINGS' });
  });

  it('still returns a usable cluster.health even when fully uninitialized', async () => {
    const client = makeClient({
      indexExists: false,
      clusterHealth: { cluster_name: 'kbn-1', status: 'yellow', number_of_nodes: 3 },
      versionInfo: { version: { number: '9.4.2' } },
    });

    const result = await runStatus(client);

    expect(result.cluster).toEqual({
      name: 'kbn-1',
      status: 'yellow',
      node_count: 3,
      version: '9.4.2',
    });
  });

  it('returns initialized:true with full data on a healthy cluster', async () => {
    const client = makeClient({
      indexExists: true,
      settingsDoc: {
        doctype: 'settings',
        repo_name_prefix: 'deepfreeze',
        provider: 'aws',
      },
      repoHits: [
        {
          _id: 'r1',
          _source: {
            doctype: 'repository',
            name: 'deepfreeze-000001',
            bucket: 'mycorp-deepfreeze',
            base_path: 'snapshots/2026-05',
            is_mounted: false, // stored value — should be overridden
            thaw_state: 'active',
          },
        },
        {
          _id: 'r2',
          _source: {
            doctype: 'repository',
            name: 'deepfreeze-000002',
            bucket: 'mycorp-deepfreeze',
            base_path: 'snapshots/2026-04',
            is_mounted: true, // stored value — should be overridden
            thaw_state: 'frozen',
          },
        },
      ],
      thawHits: [
        {
          _id: 'req-1',
          _source: {
            doctype: 'thaw_request',
            request_id: 'req-1',
            repos: ['deepfreeze-000002'],
            status: 'in_progress',
            created_at: '2026-05-15T12:00:00Z',
          },
        },
      ],
      // Only the first repo is currently a mounted snapshot repository in ES.
      snapshotRepos: { 'deepfreeze-000001': {} },
      ilmPolicies: {
        'cold-policy': {
          policy: {
            phases: {
              cold: {
                actions: {
                  searchable_snapshot: { snapshot_repository: 'deepfreeze-000001' },
                },
              },
            },
          },
          in_use_by: { indices: ['idx-a'] },
        },
      },
    });

    const result = await runStatus(client);

    expect(result.initialized).toBe(true);
    expect(result.errors).toEqual([]);

    // Settings round-trip with defaults filled in for omitted fields
    expect(result.settings?.repo_name_prefix).toBe('deepfreeze');
    expect(result.settings?.style).toBe(SETTINGS_DEFAULTS.style);

    // is_mounted is the LIVE value (overrides the stored value)
    expect(result.repositories).toHaveLength(2);
    const byName = Object.fromEntries(result.repositories.map((r) => [r.name, r]));
    expect(byName['deepfreeze-000001'].is_mounted).toBe(true);
    expect(byName['deepfreeze-000002'].is_mounted).toBe(false);

    expect(result.thaw_requests).toHaveLength(1);
    expect(result.thaw_requests[0].request_id).toBe('req-1');

    expect(result.ilm_policies).toHaveLength(1);
    expect(result.ilm_policies[0]).toMatchObject({
      name: 'cold-policy',
      repository: 'deepfreeze-000001',
      indices_count: 1,
    });

    expect(result.buckets).toEqual([]); // Phase 4 placeholder
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('does not throw if a sub-fetch fails — records a warning instead', async () => {
    const client = makeClient({
      indexExists: true,
      settingsDoc: { doctype: 'settings', repo_name_prefix: 'deepfreeze' },
      failIlm: true,
    });

    const result = await runStatus(client);

    expect(result.initialized).toBe(true);
    expect(result.ilm_policies).toEqual([]);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'INTERNAL_ERROR',
        message: expect.stringContaining('boom-ilm'),
      })
    );
  });

  it('survives a cluster.health failure with a degraded ClusterHealth and a warning', async () => {
    const client = makeClient({
      indexExists: true,
      settingsDoc: { doctype: 'settings', repo_name_prefix: 'deepfreeze' },
      failCluster: true,
    });

    const result = await runStatus(client);

    expect(result.cluster.status).toBe('unknown');
    expect(result.initialized).toBe(true);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'INTERNAL_ERROR',
        message: expect.stringContaining('boom-cluster'),
      })
    );
  });

  it('uses the configured repo_name_prefix for ILM policy filtering', async () => {
    const client = makeClient({
      indexExists: true,
      settingsDoc: { doctype: 'settings', repo_name_prefix: 'mycorp-deepfreeze' },
      ilmPolicies: {
        'matches-prefix': {
          policy: {
            phases: {
              cold: {
                actions: {
                  searchable_snapshot: { snapshot_repository: 'mycorp-deepfreeze-001' },
                },
              },
            },
          },
        },
        'wrong-prefix': {
          policy: {
            phases: {
              cold: {
                actions: {
                  searchable_snapshot: { snapshot_repository: 'deepfreeze-other' },
                },
              },
            },
          },
        },
      },
    });

    const result = await runStatus(client);

    expect(result.ilm_policies.map((p) => p.name)).toEqual(['matches-prefix']);
  });
});
