import { AwsStorageClient, parseRestoreHeader, type S3ClientApi } from '../aws_client';

interface FakeOpts {
  /** Pages of objects to return from listObjectsV2. */
  listPages?: Array<{
    Contents?: Array<{ Key?: string; Size?: number; StorageClass?: string }>;
    NextContinuationToken?: string;
    IsTruncated?: boolean;
  }>;
  /** Map of key → HeadObject response. */
  heads?: Record<string, { StorageClass?: string; Restore?: string }>;
  /** Make headBucket throw. */
  failHeadBucket?: boolean;
}

interface Trace {
  list_calls: Array<{ Bucket: string; Prefix: string; ContinuationToken?: string }>;
  head_calls: Array<{ Bucket: string; Key: string }>;
  restore_calls: Array<{
    Bucket: string;
    Key: string;
    RestoreRequest: { Days: number; GlacierJobParameters?: { Tier: string } };
  }>;
  head_bucket_calls: string[];
}

function makeApi(opts: FakeOpts = {}): { api: S3ClientApi; trace: Trace } {
  const trace: Trace = {
    list_calls: [],
    head_calls: [],
    restore_calls: [],
    head_bucket_calls: [],
  };

  let pageIndex = 0;
  const api: S3ClientApi = {
    listObjectsV2: async (params) => {
      trace.list_calls.push(params);
      const page = opts.listPages?.[pageIndex] ?? { Contents: [] };
      pageIndex += 1;
      return page;
    },
    headObject: async ({ Bucket, Key }) => {
      trace.head_calls.push({ Bucket, Key });
      return opts.heads?.[Key] ?? { StorageClass: 'STANDARD' };
    },
    restoreObject: async (params) => {
      trace.restore_calls.push(params);
      return {};
    },
    headBucket: async ({ Bucket }) => {
      trace.head_bucket_calls.push(Bucket);
      if (opts.failHeadBucket) throw new Error('access-denied');
      return {};
    },
  };

  return { api, trace };
}

describe('parseRestoreHeader', () => {
  it('returns null for an undefined or empty header', () => {
    expect(parseRestoreHeader(undefined)).toBeNull();
    expect(parseRestoreHeader('')).toBeNull();
  });

  it('parses ongoing="true" with no expiry as ongoing restore', () => {
    expect(parseRestoreHeader('ongoing-request="true"')).toEqual({ ongoing: true });
  });

  it('parses ongoing="false" with expiry as completed restore', () => {
    expect(
      parseRestoreHeader('ongoing-request="false", expiry-date="Tue, 31 Dec 2026 00:00:00 GMT"')
    ).toEqual({ ongoing: false, expiry_date: 'Tue, 31 Dec 2026 00:00:00 GMT' });
  });

  it('returns null when the header is malformed', () => {
    expect(parseRestoreHeader('not-a-restore-header')).toBeNull();
  });
});

describe('AwsStorageClient.testConnection', () => {
  it('returns true on successful headBucket', async () => {
    const { api, trace } = makeApi();
    const client = new AwsStorageClient(api);
    expect(await client.testConnection('my-bucket')).toBe(true);
    expect(trace.head_bucket_calls).toEqual(['my-bucket']);
  });

  it('returns false when headBucket throws', async () => {
    const { api } = makeApi({ failHeadBucket: true });
    const client = new AwsStorageClient(api);
    expect(await client.testConnection('my-bucket')).toBe(false);
  });
});

describe('AwsStorageClient.listObjects', () => {
  it('flattens a multi-page response and stops when IsTruncated is false', async () => {
    const { api, trace } = makeApi({
      listPages: [
        {
          Contents: [
            { Key: 'a', Size: 10, StorageClass: 'STANDARD' },
            { Key: 'b', Size: 20, StorageClass: 'GLACIER' },
          ],
          NextContinuationToken: 't1',
          IsTruncated: true,
        },
        {
          Contents: [{ Key: 'c', Size: 30, StorageClass: 'STANDARD' }],
          IsTruncated: false,
        },
      ],
    });
    const client = new AwsStorageClient(api);

    const result = await client.listObjects('b', 'prefix/');
    expect(result).toEqual([
      { key: 'a', size: 10, storage_class: 'STANDARD' },
      { key: 'b', size: 20, storage_class: 'GLACIER' },
      { key: 'c', size: 30, storage_class: 'STANDARD' },
    ]);

    expect(trace.list_calls).toEqual([
      { Bucket: 'b', Prefix: 'prefix/', ContinuationToken: undefined },
      { Bucket: 'b', Prefix: 'prefix/', ContinuationToken: 't1' },
    ]);
  });

  it('returns an empty array when the bucket prefix has no objects', async () => {
    const { api } = makeApi({ listPages: [{ Contents: [], IsTruncated: false }] });
    const client = new AwsStorageClient(api);
    expect(await client.listObjects('b', 'x/')).toEqual([]);
  });

  it('skips objects without a Key (defensive)', async () => {
    const { api } = makeApi({
      listPages: [{ Contents: [{ Size: 0 }, { Key: 'a', Size: 1 }], IsTruncated: false }],
    });
    const client = new AwsStorageClient(api);
    const result = await client.listObjects('b', 'x/');
    expect(result.map((o) => o.key)).toEqual(['a']);
  });
});

describe('AwsStorageClient.headObject', () => {
  it('marks STANDARD objects as accessible without a restore record', async () => {
    const { api } = makeApi({ heads: { 'obj-1': { StorageClass: 'STANDARD' } } });
    const client = new AwsStorageClient(api);
    expect(await client.headObject('b', 'obj-1')).toEqual({
      storage_class: 'STANDARD',
      accessible: true,
      restore: null,
    });
  });

  it('marks STANDARD_IA / ONEZONE_IA / REDUCED_REDUNDANCY as always accessible', async () => {
    for (const sc of ['STANDARD_IA', 'ONEZONE_IA', 'REDUCED_REDUNDANCY']) {
      const { api } = makeApi({ heads: { o: { StorageClass: sc } } });
      const client = new AwsStorageClient(api);
      const r = await client.headObject('b', 'o');
      expect(r.accessible).toBe(true);
      expect(r.storage_class).toBe(sc);
    }
  });

  it('marks INTELLIGENT_TIERING with no Restore header as accessible', async () => {
    const { api } = makeApi({ heads: { o: { StorageClass: 'INTELLIGENT_TIERING' } } });
    const client = new AwsStorageClient(api);
    expect((await client.headObject('b', 'o')).accessible).toBe(true);
  });

  it('marks GLACIER with no restore on file as not accessible', async () => {
    const { api } = makeApi({ heads: { o: { StorageClass: 'GLACIER' } } });
    const client = new AwsStorageClient(api);
    expect(await client.headObject('b', 'o')).toEqual({
      storage_class: 'GLACIER',
      accessible: false,
      restore: null,
    });
  });

  it('marks GLACIER with ongoing restore as not yet accessible', async () => {
    const { api } = makeApi({
      heads: { o: { StorageClass: 'GLACIER', Restore: 'ongoing-request="true"' } },
    });
    const client = new AwsStorageClient(api);
    expect(await client.headObject('b', 'o')).toEqual({
      storage_class: 'GLACIER',
      accessible: false,
      restore: { ongoing: true },
    });
  });

  it('marks GLACIER with completed restore (ongoing=false) as accessible', async () => {
    const { api } = makeApi({
      heads: {
        o: {
          StorageClass: 'GLACIER',
          Restore: 'ongoing-request="false", expiry-date="Tue, 31 Dec 2026 00:00:00 GMT"',
        },
      },
    });
    const client = new AwsStorageClient(api);
    const r = await client.headObject('b', 'o');
    expect(r.accessible).toBe(true);
    expect(r.restore).toEqual({ ongoing: false, expiry_date: 'Tue, 31 Dec 2026 00:00:00 GMT' });
  });
});

describe('AwsStorageClient.restoreObject', () => {
  it('issues RestoreObject for cold objects with the requested Days + Tier', async () => {
    const { api, trace } = makeApi({ heads: { o: { StorageClass: 'GLACIER' } } });
    const client = new AwsStorageClient(api);
    await client.restoreObject('b', 'o', { days: 7, tier: 'Bulk' });
    expect(trace.restore_calls).toEqual([
      {
        Bucket: 'b',
        Key: 'o',
        RestoreRequest: { Days: 7, GlacierJobParameters: { Tier: 'Bulk' } },
      },
    ]);
  });

  it("defaults the retrieval tier to 'Standard' when omitted", async () => {
    const { api, trace } = makeApi({ heads: { o: { StorageClass: 'GLACIER' } } });
    const client = new AwsStorageClient(api);
    await client.restoreObject('b', 'o', { days: 7 });
    expect(trace.restore_calls[0].RestoreRequest.GlacierJobParameters?.Tier).toBe('Standard');
  });

  it('skips the RestoreObject call when the object is already accessible', async () => {
    const { api, trace } = makeApi({ heads: { o: { StorageClass: 'STANDARD' } } });
    const client = new AwsStorageClient(api);
    await client.restoreObject('b', 'o', { days: 7 });
    expect(trace.restore_calls).toEqual([]);
  });

  it('skips the RestoreObject call when a restore is already in flight', async () => {
    const { api, trace } = makeApi({
      heads: { o: { StorageClass: 'GLACIER', Restore: 'ongoing-request="true"' } },
    });
    const client = new AwsStorageClient(api);
    await client.restoreObject('b', 'o', { days: 7 });
    expect(trace.restore_calls).toEqual([]);
  });
});
