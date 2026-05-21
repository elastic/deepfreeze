import {
  createSnapshotRepository,
  getBucketsInUse,
  getReposMatchingPrefix,
  getS3ClientNamesInUse,
  getSnapshotRepositoryConfigs,
  isBucketBasePathInUse,
  type SnapshotRepoEsClient,
} from '../snapshot_repo';

interface FakeOpts {
  repos?: Record<string, { type: string; settings: Record<string, unknown> }>;
  capture?: (args: Record<string, unknown>) => void;
}

function makeClient(opts: FakeOpts = {}): SnapshotRepoEsClient {
  return {
    snapshot: {
      getRepository: async () => opts.repos ?? {},
      createRepository: async (args) => {
        opts.capture?.(args);
        return {};
      },
    },
  };
}

describe('getSnapshotRepositoryConfigs', () => {
  it('normalizes s3 / gcs / azure repos into a flat shape', async () => {
    const client = makeClient({
      repos: {
        'df-001': { type: 's3', settings: { bucket: 'b1', base_path: 'snapshots-1' } },
        'df-002': { type: 'gcs', settings: { bucket: 'b2', base_path: 'snapshots-2' } },
        'df-003': { type: 'azure', settings: { container: 'b3', base_path: 'snapshots-3' } },
        'local-fs': { type: 'fs', settings: {} },
      },
    });

    const cfgs = await getSnapshotRepositoryConfigs(client);
    expect(cfgs).toEqual(
      expect.arrayContaining([
        { name: 'df-001', type: 's3', bucket: 'b1', base_path: 'snapshots-1', client: 'default' },
        { name: 'df-002', type: 'gcs', bucket: 'b2', base_path: 'snapshots-2', client: '' },
        { name: 'df-003', type: 'azure', bucket: 'b3', base_path: 'snapshots-3', client: '' },
        { name: 'local-fs', type: 'fs', bucket: '', base_path: '', client: '' },
      ])
    );
  });

  it("uses the explicit s3 settings.client when set, defaulting to 'default'", async () => {
    const client = makeClient({
      repos: {
        'df-explicit': {
          type: 's3',
          settings: { bucket: 'b1', base_path: 'snapshots', client: 'archive' },
        },
        'df-implicit': { type: 's3', settings: { bucket: 'b2', base_path: 'snapshots' } },
      },
    });

    const cfgs = await getSnapshotRepositoryConfigs(client);
    const byName = Object.fromEntries(cfgs.map((c) => [c.name, c]));
    expect(byName['df-explicit'].client).toBe('archive');
    expect(byName['df-implicit'].client).toBe('default');
  });
});

describe('getS3ClientNamesInUse', () => {
  it('returns deduplicated sorted s3 client names and ignores non-s3 repos', async () => {
    const client = makeClient({
      repos: {
        a: { type: 's3', settings: { bucket: 'b1', base_path: '1', client: 'default' } },
        b: { type: 's3', settings: { bucket: 'b2', base_path: '2', client: 'archive' } },
        c: { type: 's3', settings: { bucket: 'b3', base_path: '3', client: 'default' } },
        d: { type: 'gcs', settings: { bucket: 'b4', base_path: '4' } },
        e: { type: 'fs', settings: {} },
      },
    });

    expect(await getS3ClientNamesInUse(client)).toEqual(['archive', 'default']);
  });

  it('returns an empty array when no s3 repos exist', async () => {
    const client = makeClient({
      repos: {
        a: { type: 'gcs', settings: { bucket: 'b1', base_path: '1' } },
      },
    });

    expect(await getS3ClientNamesInUse(client)).toEqual([]);
  });
});

describe('getBucketsInUse', () => {
  it('returns deduplicated, sorted bucket names and excludes non-cloud repos', async () => {
    const client = makeClient({
      repos: {
        a: { type: 's3', settings: { bucket: 'z-bucket', base_path: 'a' } },
        b: { type: 's3', settings: { bucket: 'a-bucket', base_path: 'b' } },
        c: { type: 's3', settings: { bucket: 'a-bucket', base_path: 'c' } },
        d: { type: 'fs', settings: {} },
      },
    });

    expect(await getBucketsInUse(client)).toEqual(['a-bucket', 'z-bucket']);
  });

  it('returns empty array when the cluster has no snapshot repos', async () => {
    const client = makeClient({ repos: {} });
    expect(await getBucketsInUse(client)).toEqual([]);
  });
});

describe('isBucketBasePathInUse', () => {
  const client = makeClient({
    repos: {
      a: { type: 's3', settings: { bucket: 'b1', base_path: 'snapshots-1' } },
    },
  });

  it('returns true on exact match', async () => {
    expect(await isBucketBasePathInUse(client, 'b1', 'snapshots-1')).toBe(true);
  });

  it('returns false when only the bucket matches', async () => {
    expect(await isBucketBasePathInUse(client, 'b1', 'snapshots-2')).toBe(false);
  });

  it('returns false when only the base_path matches', async () => {
    expect(await isBucketBasePathInUse(client, 'b2', 'snapshots-1')).toBe(false);
  });
});

describe('getReposMatchingPrefix', () => {
  it('returns only names that start with the prefix', async () => {
    const client = makeClient({
      repos: {
        'deepfreeze-000001': { type: 's3', settings: {} },
        'deepfreeze-000002': { type: 's3', settings: {} },
        'other-repo': { type: 's3', settings: {} },
      },
    });

    expect(await getReposMatchingPrefix(client, 'deepfreeze')).toEqual([
      'deepfreeze-000001',
      'deepfreeze-000002',
    ]);
  });
});

describe('createSnapshotRepository', () => {
  it('uses s3 type and includes canned_acl + storage_class for aws', async () => {
    const captured: Record<string, unknown>[] = [];
    const client = makeClient({ capture: (args) => captured.push(args) });

    await createSnapshotRepository(client, {
      name: 'df-000001',
      provider: 'aws',
      bucket: 'my-bucket',
      base_path: 'snapshots-000001',
      canned_acl: 'private',
      storage_class: 'intelligent_tiering',
    });

    expect(captured).toEqual([
      {
        name: 'df-000001',
        repository: {
          type: 's3',
          settings: {
            bucket: 'my-bucket',
            base_path: 'snapshots-000001',
            canned_acl: 'private',
            storage_class: 'intelligent_tiering',
          },
        },
        verify: true,
      },
    ]);
  });

  it('uses azure type with container key for azure', async () => {
    const captured: Record<string, unknown>[] = [];
    const client = makeClient({ capture: (args) => captured.push(args) });

    await createSnapshotRepository(client, {
      name: 'df-000001',
      provider: 'azure',
      bucket: 'my-container',
      base_path: 'snapshots-000001',
    });

    expect(captured[0]).toMatchObject({
      repository: {
        type: 'azure',
        settings: { container: 'my-container', base_path: 'snapshots-000001' },
      },
    });
  });

  it('uses gcs type with bucket key for gcp', async () => {
    const captured: Record<string, unknown>[] = [];
    const client = makeClient({ capture: (args) => captured.push(args) });

    await createSnapshotRepository(client, {
      name: 'df-000001',
      provider: 'gcp',
      bucket: 'my-bucket',
      base_path: 'snapshots-000001',
    });

    expect(captured[0]).toMatchObject({
      repository: { type: 'gcs', settings: { bucket: 'my-bucket', base_path: 'snapshots-000001' } },
    });
  });
});
