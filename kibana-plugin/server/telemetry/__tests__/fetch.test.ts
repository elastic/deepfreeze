import { fetchDeepfreezeUsage } from '../fetch';
import type { StatusActionEsClient } from '../../actions/status';
import { SETTINGS_DEFAULTS } from '../../../common/schemas/settings';
import { DOCTYPE, SETTINGS_ID, STATUS_INDEX } from '../../../common/constants';

interface FakeOpts {
  indexExists?: boolean;
  settingsDoc?: Record<string, unknown> | null;
  repoHits?: Array<{ _id: string; _source: Record<string, unknown> }>;
  thawHits?: Array<{ _id: string; _source: Record<string, unknown> }>;
  snapshotRepos?: Record<string, unknown>;
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
      get_repository: async () => opts.snapshotRepos ?? {},
    },
    ilm: {
      get_lifecycle: async () => ({}),
    },
    cluster: {
      health: async () => ({
        cluster_name: 'test',
        status: 'green',
        number_of_nodes: 1,
      }),
    },
    info: async () => ({ version: { number: '9.4.2' } }),
  };
}

describe('fetchDeepfreezeUsage', () => {
  it('returns the empty/zeroed shape when the cluster is uninitialized', async () => {
    const client = makeClient({ indexExists: false });

    const usage = await fetchDeepfreezeUsage(client);

    expect(usage).toEqual({
      initialized: false,
      provider: 'unknown',
      rotate_by: 'unknown',
      style: 'unknown',
      repositories_total: 0,
      repositories_active: 0,
      repositories_frozen: 0,
      repositories_thawing: 0,
      repositories_thawed: 0,
      repositories_expired: 0,
      repositories_mounted: 0,
      thaw_requests_total: 0,
      thaw_requests_in_progress: 0,
      thaw_requests_completed: 0,
      thaw_requests_failed: 0,
      thaw_requests_refrozen: 0,
    });
  });

  it('reports zero counts when initialized but empty', async () => {
    const client = makeClient({
      indexExists: true,
      settingsDoc: { ...SETTINGS_DEFAULTS, provider: 'azure', rotate_by: 'bucket', style: 'date' },
    });

    const usage = await fetchDeepfreezeUsage(client);

    expect(usage.initialized).toBe(true);
    expect(usage.provider).toBe('azure');
    expect(usage.rotate_by).toBe('bucket');
    expect(usage.style).toBe('date');
    expect(usage.repositories_total).toBe(0);
    expect(usage.thaw_requests_total).toBe(0);
  });

  it('aggregates repository state counts and live-mount counts', async () => {
    const repoHits = [
      mkRepoHit('repo-a', 'active', true),
      mkRepoHit('repo-b', 'frozen', false),
      mkRepoHit('repo-c', 'frozen', false),
      mkRepoHit('repo-d', 'thawing', true),
      mkRepoHit('repo-e', 'thawed', true),
      mkRepoHit('repo-f', 'expired', false),
    ];

    const client = makeClient({
      indexExists: true,
      // repo_name_prefix matches all of repo-* below, so the live
      // mounted-set check picks them up.
      settingsDoc: { ...SETTINGS_DEFAULTS, repo_name_prefix: 'repo' },
      repoHits,
      // is_mounted is overridden by snapshot.get_repository (see actions/status.ts).
      snapshotRepos: { 'repo-a': {}, 'repo-d': {}, 'repo-e': {} },
    });

    const usage = await fetchDeepfreezeUsage(client);

    expect(usage.repositories_total).toBe(6);
    expect(usage.repositories_active).toBe(1);
    expect(usage.repositories_frozen).toBe(2);
    expect(usage.repositories_thawing).toBe(1);
    expect(usage.repositories_thawed).toBe(1);
    expect(usage.repositories_expired).toBe(1);
    expect(usage.repositories_mounted).toBe(3);
  });

  it('aggregates thaw request status counts', async () => {
    const thawHits = [
      mkThawHit('t-1', 'in_progress'),
      mkThawHit('t-2', 'in_progress'),
      mkThawHit('t-3', 'completed'),
      mkThawHit('t-4', 'failed'),
      mkThawHit('t-5', 'refrozen'),
      mkThawHit('t-6', 'refrozen'),
    ];

    const client = makeClient({
      indexExists: true,
      settingsDoc: SETTINGS_DEFAULTS,
      thawHits,
    });

    const usage = await fetchDeepfreezeUsage(client);

    expect(usage.thaw_requests_total).toBe(6);
    expect(usage.thaw_requests_in_progress).toBe(2);
    expect(usage.thaw_requests_completed).toBe(1);
    expect(usage.thaw_requests_failed).toBe(1);
    expect(usage.thaw_requests_refrozen).toBe(2);
  });
});

function mkRepoHit(name: string, thaw_state: string, is_mounted: boolean) {
  return {
    _id: name,
    _source: {
      doctype: DOCTYPE.repository,
      name,
      bucket: 'b',
      base_path: 'p',
      start: null,
      end: null,
      is_thawed: false,
      is_mounted,
      thaw_state,
      thawed_at: null,
      expires_at: null,
    },
  };
}

function mkThawHit(request_id: string, status: string) {
  return {
    _id: request_id,
    _source: {
      doctype: DOCTYPE.thaw_request,
      request_id,
      repos: [],
      status,
      created_at: '2026-05-01T00:00:00Z',
    },
  };
}
