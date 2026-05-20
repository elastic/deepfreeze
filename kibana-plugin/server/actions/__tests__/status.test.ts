import { runStatus, type StatusActionEsClient } from '../status';
import { SETTINGS_DEFAULTS } from '../../../common/schemas/settings';
import { DOCTYPE, SETTINGS_ID, STATUS_INDEX } from '../../../common/constants';
import type { StorageClient, StorageObject } from '../../storage/types';

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

  describe('storage_tier sampling', () => {
    /**
     * Stub StorageClient. The `objects` map is keyed by
     * `${bucket}/${prefix}` and provides per-repo object lists. Repos
     * not in the map return an empty list (→ tier "Empty").
     */
    function makeStorage(
      objects: Record<string, StorageObject[]>,
      opts: { failPrefixes?: string[] } = {}
    ): StorageClient {
      return {
        testConnection: async () => true,
        listObjects: async (bucket, prefix) => {
          const key = `${bucket}/${prefix}`;
          if (opts.failPrefixes?.includes(key)) {
            throw new Error(`list boom for ${key}`);
          }
          return objects[key] ?? [];
        },
        headObject: async () => ({
          storage_class: 'GLACIER',
          accessible: false,
          restore: null,
        }),
        restoreObject: async () => {},
      };
    }

    function obj(storage_class: string, key = 'k'): StorageObject {
      return { key, size: 1, storage_class };
    }

    const settingsDoc = {
      doctype: 'settings',
      repo_name_prefix: 'deepfreeze',
      provider: 'aws',
    };

    const repoHits = [
      {
        _id: 'hot',
        _source: {
          doctype: 'repository',
          name: 'hot',
          bucket: 'b',
          base_path: 'snapshots/hot',
          is_mounted: true,
          thaw_state: 'active',
        },
      },
      {
        _id: 'archived',
        _source: {
          doctype: 'repository',
          name: 'archived',
          bucket: 'b',
          base_path: 'snapshots/archived',
          is_mounted: false,
          thaw_state: 'frozen',
        },
      },
    ];

    it('classifies single-class samples as Standard / Archive', async () => {
      const client = makeClient({ indexExists: true, settingsDoc, repoHits });
      const storage = makeStorage({
        'b/snapshots/hot/': [obj('STANDARD'), obj('STANDARD'), obj('STANDARD')],
        'b/snapshots/archived/': [obj('GLACIER'), obj('GLACIER')],
      });

      const result = await runStatus(client, { storage });

      const byName = Object.fromEntries(
        result.repositories.map((r) => [r.name, r])
      );
      expect(byName.hot.storage_tier).toBe('Standard');
      expect(byName.archived.storage_tier).toBe('Archive');
    });

    it('classifies a multi-class sample as Mixed', async () => {
      const client = makeClient({ indexExists: true, settingsDoc, repoHits });
      const storage = makeStorage({
        'b/snapshots/hot/': [obj('STANDARD'), obj('GLACIER')],
        'b/snapshots/archived/': [obj('GLACIER')],
      });

      const result = await runStatus(client, { storage });
      const byName = Object.fromEntries(
        result.repositories.map((r) => [r.name, r])
      );
      expect(byName.hot.storage_tier).toBe('Mixed');
      expect(byName.archived.storage_tier).toBe('Archive');
    });

    it('returns Empty when listObjects yields nothing', async () => {
      const client = makeClient({ indexExists: true, settingsDoc, repoHits });
      const storage = makeStorage({});

      const result = await runStatus(client, { storage });
      expect(result.repositories.every((r) => r.storage_tier === 'Empty')).toBe(true);
    });

    it("returns N/A on listObjects errors and doesn't poison the rest", async () => {
      const client = makeClient({ indexExists: true, settingsDoc, repoHits });
      const storage = makeStorage(
        {
          'b/snapshots/hot/': [obj('STANDARD')],
          'b/snapshots/archived/': [obj('GLACIER')],
        },
        { failPrefixes: ['b/snapshots/hot/'] }
      );

      const result = await runStatus(client, { storage });
      const byName = Object.fromEntries(
        result.repositories.map((r) => [r.name, r])
      );
      expect(byName.hot.storage_tier).toBe('N/A');
      expect(byName.archived.storage_tier).toBe('Archive');
      // runStatus.errors should not be polluted — sampling failures
      // surface as the per-repo 'N/A' tier, not as response errors.
      expect(result.errors).toEqual([]);
    });

    it('returns Unknown for storage classes not in the mapping table', async () => {
      const client = makeClient({ indexExists: true, settingsDoc, repoHits });
      const storage = makeStorage({
        'b/snapshots/hot/': [obj('FUTURE_TIER_X')],
        'b/snapshots/archived/': [obj('GLACIER')],
      });
      const result = await runStatus(client, { storage });
      const byName = Object.fromEntries(
        result.repositories.map((r) => [r.name, r])
      );
      expect(byName.hot.storage_tier).toBe('Unknown');
    });

    it('omits storage_tier when no storage client is supplied', async () => {
      const client = makeClient({ indexExists: true, settingsDoc, repoHits });
      const result = await runStatus(client);
      expect(result.repositories.every((r) => r.storage_tier === undefined)).toBe(
        true
      );
    });

    it("normalises Azure's 'Hot' tier to 'Standard'", async () => {
      const azureHits = [
        {
          _id: 'azh',
          _source: {
            doctype: 'repository',
            name: 'azh',
            bucket: 'b',
            base_path: 'azure-hot',
            is_mounted: true,
            thaw_state: 'active',
          },
        },
      ];
      const client = makeClient({
        indexExists: true,
        settingsDoc,
        repoHits: azureHits,
      });
      const storage = makeStorage({
        // Azure literally returns "Hot" as a storage_class value.
        'b/azure-hot/': [obj('Hot')],
      });
      const result = await runStatus(client, { storage });
      expect(result.repositories[0].storage_tier).toBe('Standard');
    });

    it('normalises Azure and GCS storage classes correctly', async () => {
      const azureHits = [
        {
          _id: 'azc',
          _source: {
            doctype: 'repository',
            name: 'azc',
            bucket: 'b',
            base_path: 'cool',
            is_mounted: true,
            thaw_state: 'active',
          },
        },
        {
          _id: 'gcsa',
          _source: {
            doctype: 'repository',
            name: 'gcsa',
            bucket: 'b',
            base_path: 'gcs-archive',
            is_mounted: false,
            thaw_state: 'frozen',
          },
        },
      ];
      const client = makeClient({
        indexExists: true,
        settingsDoc,
        repoHits: azureHits,
      });
      const storage = makeStorage({
        'b/cool/': [obj('Cool')], // Azure access tier
        'b/gcs-archive/': [obj('COLDLINE')], // GCS storage class
      });
      const result = await runStatus(client, { storage });
      const byName = Object.fromEntries(
        result.repositories.map((r) => [r.name, r])
      );
      expect(byName.azc.storage_tier).toBe('Cool');
      expect(byName.gcsa.storage_tier).toBe('Archive');
    });
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
