import {
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
      get_repository: async () => opts.snapshotRepos ?? {},
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
