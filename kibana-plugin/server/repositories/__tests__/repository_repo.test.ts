import {
  findReposByDateRange,
  getAllRepos,
  getMatchingRepoNames,
  type RepositoryRepoEsClient,
} from '../repository_repo';
import { DOCTYPE, STATUS_INDEX } from '../../../common/constants';

interface FakeOpts {
  repoHits?: Array<{ _id: string; _source: Record<string, unknown> }>;
  snapshotRepos?: Record<string, unknown>;
}

function makeClient(opts: FakeOpts = {}): RepositoryRepoEsClient {
  return {
    search: async (params) => {
      expect(params.index).toBe(STATUS_INDEX);
      expect(params.size).toBe(10000);
      expect(params.query).toEqual({ match: { doctype: DOCTYPE.repository } });
      return { hits: { hits: opts.repoHits ?? [] } };
    },
    snapshot: {
      getRepository: async () => opts.snapshotRepos ?? {},
    },
  };
}

describe('getAllRepos', () => {
  it('returns the _source of every repository hit', async () => {
    const client = makeClient({
      repoHits: [
        {
          _id: 'r1',
          _source: {
            doctype: 'repository',
            name: 'deepfreeze-000001',
            bucket: 'mycorp-deepfreeze',
            base_path: 'snapshots/2026-05',
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
            thaw_state: 'frozen',
          },
        },
      ],
    });

    const repos = await getAllRepos(client);

    expect(repos).toHaveLength(2);
    expect(repos[0].name).toBe('deepfreeze-000001');
    expect(repos[1].thaw_state).toBe('frozen');
  });

  it('returns [] when no repositories are stored', async () => {
    const client = makeClient({ repoHits: [] });
    await expect(getAllRepos(client)).resolves.toEqual([]);
  });
});

describe('getMatchingRepoNames', () => {
  it('returns snapshot-repo names matching the prefix (substring match)', async () => {
    const client = makeClient({
      snapshotRepos: {
        'deepfreeze-000001': {},
        'deepfreeze-000002': {},
        'unrelated-repo': {},
        'mycorp-deepfreeze-archive': {},
      },
    });

    const matches = await getMatchingRepoNames(client, 'deepfreeze');

    expect(matches.sort()).toEqual([
      'deepfreeze-000001',
      'deepfreeze-000002',
      'mycorp-deepfreeze-archive',
    ]);
  });

  it('returns [] when no snapshot repositories are registered', async () => {
    const client = makeClient({ snapshotRepos: {} });
    await expect(getMatchingRepoNames(client, 'deepfreeze')).resolves.toEqual([]);
  });

  it('handles regex-special characters in the prefix the same way Python does (raw search)', async () => {
    // Python uses re.compile(prefix).search(name). TS port uses
    // new RegExp(prefix).test(name). Both treat '.' as 'any character'
    // — a quirk we preserve intentionally for parity.
    const client = makeClient({
      snapshotRepos: {
        'deepfreeze-prod': {},
        'deepfreezeXprod': {},
      },
    });

    const matches = await getMatchingRepoNames(client, 'deepfreeze.prod');

    // Both names match the regex 'deepfreeze.prod' (the dot is wild)
    expect(matches.sort()).toEqual(['deepfreeze-prod', 'deepfreezeXprod']);
  });
});

describe('findReposByDateRange', () => {
  /**
   * findReposByDateRange uses a different ES query shape than getAllRepos,
   * so it needs its own fake (the shared one above asserts the simpler
   * `match: doctype` query and would reject the bool/range form).
   */
  function makeRangeClient(opts: {
    repoHits?: Array<{ _id: string; _source: Record<string, unknown> }>;
    throwStatus?: number;
  }): RepositoryRepoEsClient {
    return {
      search: async (params) => {
        if (opts.throwStatus !== undefined) {
          const err = new Error('boom') as Error & {
            statusCode?: number;
            meta?: { statusCode?: number };
          };
          err.statusCode = opts.throwStatus;
          err.meta = { statusCode: opts.throwStatus };
          throw err;
        }
        expect(params.index).toBe(STATUS_INDEX);
        expect(params.size).toBe(10000);
        // Quick structural sanity-check on the bool/range query
        const query = params.query as Record<string, unknown>;
        const bool = (query.bool ?? {}) as { must?: unknown[] };
        expect(Array.isArray(bool.must)).toBe(true);
        return { hits: { hits: opts.repoHits ?? [] } };
      },
      snapshot: { getRepository: async () => ({}) },
    };
  }

  it('returns the _source of repos that overlap the range', async () => {
    const client = makeRangeClient({
      repoHits: [
        {
          _id: 'r1',
          _source: {
            doctype: 'repository',
            name: 'deepfreeze-000001',
            bucket: 'b',
            base_path: 'snapshots/jan',
            start: '2026-01-01T00:00:00Z',
            end: '2026-01-31T23:59:59Z',
            thaw_state: 'frozen',
            is_thawed: false,
            is_mounted: false,
            thawed_at: null,
            expires_at: null,
          },
        },
      ],
    });

    const repos = await findReposByDateRange(
      client,
      '2026-01-15T00:00:00Z',
      '2026-01-20T00:00:00Z'
    );
    expect(repos).toHaveLength(1);
    expect(repos[0].name).toBe('deepfreeze-000001');
  });

  it('returns [] when the status index is missing (404)', async () => {
    const client = makeRangeClient({ throwStatus: 404 });
    await expect(
      findReposByDateRange(client, '2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z')
    ).resolves.toEqual([]);
  });

  it('propagates non-404 ES errors', async () => {
    const client = makeRangeClient({ throwStatus: 500 });
    await expect(
      findReposByDateRange(client, '2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z')
    ).rejects.toThrow();
  });

  it('builds the bool/range query overlap rule (start ≤ endIso AND end ≥ startIso)', async () => {
    let capturedQuery: Record<string, unknown> | null = null;
    const client: RepositoryRepoEsClient = {
      search: async (params) => {
        capturedQuery = params.query as Record<string, unknown>;
        return { hits: { hits: [] } };
      },
      snapshot: { getRepository: async () => ({}) },
    };

    await findReposByDateRange(
      client,
      '2026-01-15T00:00:00Z',
      '2026-01-20T00:00:00Z'
    );

    expect(capturedQuery).toEqual({
      bool: {
        must: [
          { term: { doctype: 'repository' } },
          { range: { start: { lte: '2026-01-20T00:00:00Z' } } },
          { range: { end: { gte: '2026-01-15T00:00:00Z' } } },
        ],
      },
    });
  });
});
