/**
 * Unit tests for the AWS storage factory. The factory translates
 * structural `S3ClientApi` calls into SigV4-signed REST requests via
 * `aws4` + `axios` and parses S3's XML/header responses back into the
 * structural shape.
 *
 * Neither `aws4`, `axios`, nor `fast-xml-parser` are installed in this
 * standalone workspace's `node_modules` — they live in Kibana root.
 * We declare each as a virtual jest mock so the factory's dynamic
 * imports resolve to controllable fakes.
 */

interface CapturedSignArgs {
  request: {
    host: string;
    path: string;
    method: string;
    service: string;
    region: string;
    headers: Record<string, string>;
    body?: string;
  };
  credentials: {
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
  };
}

interface CapturedAxiosCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  data?: string;
}

interface FakeResponse {
  status: number;
  data?: string;
  headers?: Record<string, string>;
}

let nextAxiosResponses: FakeResponse[];
let capturedAxiosCalls: CapturedAxiosCall[];
let capturedSignCalls: CapturedSignArgs[];

jest.mock(
  'aws4',
  () => ({
    sign: (req: CapturedSignArgs['request'], creds: CapturedSignArgs['credentials']) => {
      capturedSignCalls.push({ request: req, credentials: creds });
      const signedHeaders = {
        ...(req.headers ?? {}),
        Authorization: 'AWS4-HMAC-SHA256 Credential=test',
        Host: req.host,
      };
      return { ...req, headers: signedHeaders };
    },
  }),
  { virtual: true }
);

jest.mock(
  'axios',
  () => ({
    request: (config: CapturedAxiosCall) => {
      capturedAxiosCalls.push(config);
      const next = nextAxiosResponses.shift();
      if (!next) {
        throw new Error('no fake axios response queued');
      }
      return Promise.resolve(next);
    },
  }),
  { virtual: true }
);

jest.mock(
  'fast-xml-parser',
  () => ({
    XMLParser: class {
      // The factory configures the parser with `isArray` for Contents.
      // Our fake just returns whatever JSON-shaped object the test
      // builder passes through `parsedXml`, ignoring the input string.
      // Tests that exercise list parsing override this per-test.
      parse(input: string): unknown {
        return JSON.parse(input);
      }
    },
  }),
  { virtual: true }
);

import { storageClientFactory } from '../factory';

describe('storageClientFactory (aws4 + axios)', () => {
  beforeEach(() => {
    nextAxiosResponses = [];
    capturedAxiosCalls = [];
    capturedSignCalls = [];
  });

  describe('listObjectsV2', () => {
    it('paginates via continuation-token and concatenates pages', async () => {
      nextAxiosResponses.push({
        status: 200,
        data: JSON.stringify({
          ListBucketResult: {
            Contents: [
              { Key: 'snap/a.dat', Size: '1024', StorageClass: 'GLACIER' },
              { Key: 'snap/b.dat', Size: '2048', StorageClass: 'DEEP_ARCHIVE' },
            ],
            NextContinuationToken: 'tok-1',
            IsTruncated: 'true',
          },
        }),
      });
      nextAxiosResponses.push({
        status: 200,
        data: JSON.stringify({
          ListBucketResult: {
            Contents: [{ Key: 'snap/c.dat', Size: '512', StorageClass: 'GLACIER' }],
            IsTruncated: 'false',
          },
        }),
      });

      const storage = await storageClientFactory('aws', {
        accessKeyId: 'AK',
        secretAccessKey: 'SK',
        region: 'us-west-2',
      });
      const objects = await storage.listObjects('mybucket', 'snap/');

      expect(objects).toEqual([
        { key: 'snap/a.dat', size: 1024, storage_class: 'GLACIER' },
        { key: 'snap/b.dat', size: 2048, storage_class: 'DEEP_ARCHIVE' },
        { key: 'snap/c.dat', size: 512, storage_class: 'GLACIER' },
      ]);
      expect(capturedAxiosCalls).toHaveLength(2);
      expect(capturedAxiosCalls[1].url).toContain('continuation-token=tok-1');
    });

    it('handles single-page result (IsTruncated=false)', async () => {
      nextAxiosResponses.push({
        status: 200,
        data: JSON.stringify({
          ListBucketResult: {
            Contents: [{ Key: 'one.dat', Size: '10', StorageClass: 'STANDARD' }],
            IsTruncated: 'false',
          },
        }),
      });

      const storage = await storageClientFactory('aws', {
        accessKeyId: 'AK',
        secretAccessKey: 'SK',
        region: 'us-east-1',
      });
      const objects = await storage.listObjects('mybucket', '');

      expect(objects).toEqual([
        { key: 'one.dat', size: 10, storage_class: 'STANDARD' },
      ]);
      expect(capturedAxiosCalls).toHaveLength(1);
      expect(capturedAxiosCalls[0].method).toBe('GET');
      expect(capturedAxiosCalls[0].url).toBe('https://mybucket.s3.amazonaws.com/?list-type=2');
      expect(capturedSignCalls[0].request.service).toBe('s3');
      expect(capturedSignCalls[0].request.region).toBe('us-east-1');
      expect(capturedSignCalls[0].credentials).toEqual({
        accessKeyId: 'AK',
        secretAccessKey: 'SK',
        sessionToken: undefined,
      });
    });

    it('uses regional host for non us-east-1 region', async () => {
      nextAxiosResponses.push({
        status: 200,
        data: JSON.stringify({ ListBucketResult: { IsTruncated: 'false' } }),
      });

      const storage = await storageClientFactory('aws', {
        accessKeyId: 'AK',
        secretAccessKey: 'SK',
        region: 'eu-west-1',
      });
      await storage.listObjects('b', '');

      expect(capturedAxiosCalls[0].url).toBe('https://b.s3.eu-west-1.amazonaws.com/?list-type=2');
    });

    it('uses path-style addressing with forcePathStyle and custom endpoint', async () => {
      nextAxiosResponses.push({
        status: 200,
        data: JSON.stringify({ ListBucketResult: { IsTruncated: 'false' } }),
      });

      const storage = await storageClientFactory('aws', {
        accessKeyId: 'test',
        secretAccessKey: 'test',
        region: 'us-east-1',
        endpoint: 'http://localhost:4566',
        forcePathStyle: true,
      });
      await storage.listObjects('mybucket', '');

      expect(capturedAxiosCalls[0].url).toBe(
        'http://localhost:4566/mybucket?list-type=2'
      );
    });

    it('throws on 4xx response', async () => {
      nextAxiosResponses.push({
        status: 403,
        data: '<Error><Code>AccessDenied</Code></Error>',
      });

      const storage = await storageClientFactory('aws', {
        accessKeyId: 'AK',
        secretAccessKey: 'SK',
      });
      await expect(storage.listObjects('mybucket', '')).rejects.toThrow(/status 403/);
    });
  });

  describe('headObject', () => {
    it('extracts StorageClass and Restore headers', async () => {
      nextAxiosResponses.push({
        status: 200,
        headers: {
          'x-amz-storage-class': 'GLACIER',
          'x-amz-restore': 'ongoing-request="false", expiry-date="Fri, 23 Dec 2026 00:00:00 GMT"',
        },
      });

      const storage = await storageClientFactory('aws', {
        accessKeyId: 'AK',
        secretAccessKey: 'SK',
      });
      const state = await storage.headObject('mybucket', 'snap/a.dat');

      expect(state.storage_class).toBe('GLACIER');
      expect(state.restore).toEqual({
        ongoing: false,
        expiry_date: 'Fri, 23 Dec 2026 00:00:00 GMT',
      });
      expect(state.accessible).toBe(true);
      expect(capturedAxiosCalls[0].method).toBe('HEAD');
      expect(capturedAxiosCalls[0].url).toBe(
        'https://mybucket.s3.amazonaws.com/snap/a.dat'
      );
    });

    it('treats missing storage-class header as STANDARD', async () => {
      nextAxiosResponses.push({ status: 200, headers: {} });

      const storage = await storageClientFactory('aws', {
        accessKeyId: 'AK',
        secretAccessKey: 'SK',
      });
      const state = await storage.headObject('b', 'k');
      expect(state.storage_class).toBe('STANDARD');
      expect(state.accessible).toBe(true);
    });

    it('throws on 404', async () => {
      nextAxiosResponses.push({ status: 404, headers: {} });

      const storage = await storageClientFactory('aws', {
        accessKeyId: 'AK',
        secretAccessKey: 'SK',
      });
      await expect(storage.headObject('b', 'k')).rejects.toThrow(/not found/);
    });
  });

  describe('restoreObject', () => {
    it('skips restore when object is already accessible', async () => {
      // headObject probe returns hot tier — adapter should NOT POST.
      nextAxiosResponses.push({
        status: 200,
        headers: { 'x-amz-storage-class': 'STANDARD' },
      });

      const storage = await storageClientFactory('aws', {
        accessKeyId: 'AK',
        secretAccessKey: 'SK',
      });
      await storage.restoreObject('b', 'k', { days: 5 });

      expect(capturedAxiosCalls).toHaveLength(1); // just the HEAD probe
      expect(capturedAxiosCalls[0].method).toBe('HEAD');
    });

    it('issues POST /?restore with Days + Tier XML when archive', async () => {
      // HEAD probe: Glacier, not yet restoring.
      nextAxiosResponses.push({
        status: 200,
        headers: { 'x-amz-storage-class': 'GLACIER' },
      });
      // POST restore: 202.
      nextAxiosResponses.push({ status: 202 });

      const storage = await storageClientFactory('aws', {
        accessKeyId: 'AK',
        secretAccessKey: 'SK',
      });
      await storage.restoreObject('b', 'k', { days: 7, tier: 'Bulk' });

      expect(capturedAxiosCalls).toHaveLength(2);
      const post = capturedAxiosCalls[1];
      expect(post.method).toBe('POST');
      expect(post.url).toBe('https://b.s3.amazonaws.com/k?restore=');
      expect(post.data).toContain('<Days>7</Days>');
      expect(post.data).toContain('<Tier>Bulk</Tier>');
    });

    it('defaults to Standard tier when unspecified', async () => {
      nextAxiosResponses.push({
        status: 200,
        headers: { 'x-amz-storage-class': 'DEEP_ARCHIVE' },
      });
      nextAxiosResponses.push({ status: 202 });

      const storage = await storageClientFactory('aws', {
        accessKeyId: 'AK',
        secretAccessKey: 'SK',
      });
      await storage.restoreObject('b', 'k', { days: 1 });

      expect(capturedAxiosCalls[1].data).toContain('<Tier>Standard</Tier>');
    });
  });

  describe('testConnection (headBucket)', () => {
    it('returns true on 200', async () => {
      nextAxiosResponses.push({ status: 200, headers: {} });

      const storage = await storageClientFactory('aws', {
        accessKeyId: 'AK',
        secretAccessKey: 'SK',
      });
      const ok = await storage.testConnection('b');
      expect(ok).toBe(true);
      expect(capturedAxiosCalls[0].method).toBe('HEAD');
      expect(capturedAxiosCalls[0].url).toBe('https://b.s3.amazonaws.com/');
    });

    it('returns false on 403', async () => {
      nextAxiosResponses.push({ status: 403, headers: {} });

      const storage = await storageClientFactory('aws', {
        accessKeyId: 'AK',
        secretAccessKey: 'SK',
      });
      const ok = await storage.testConnection('b');
      expect(ok).toBe(false);
    });
  });

  describe('refreeze (factory integration)', () => {
    it('lists objects, copies non-target ones with correct CopyObject headers, skips target-class ones', async () => {
      // 1) listObjectsV2 page
      nextAxiosResponses.push({
        status: 200,
        data: JSON.stringify({
          ListBucketResult: {
            Contents: [
              { Key: 'snap/a.dat', Size: '1024', StorageClass: 'STANDARD' },
              { Key: 'snap/b.dat', Size: '2048', StorageClass: 'GLACIER' },
              { Key: 'snap/c.dat', Size: '512', StorageClass: 'STANDARD_IA' },
            ],
            IsTruncated: 'false',
          },
        }),
      });
      // 2) copyObject for a (STANDARD → GLACIER)
      nextAxiosResponses.push({ status: 200, data: '', headers: {} });
      // 3) copyObject for c (STANDARD_IA → GLACIER) — b is skipped
      nextAxiosResponses.push({ status: 200, data: '', headers: {} });

      const storage = await storageClientFactory('aws', {
        accessKeyId: 'AK',
        secretAccessKey: 'SK',
        region: 'us-east-1',
      });
      const result = await storage.refreeze('mybucket', 'snap/', 'GLACIER');

      expect(result).toEqual({ refrozen: 2, skipped: 1, errors: 0 });

      // Three axios calls: one list, two copies. (b is filtered before the API hit.)
      expect(capturedAxiosCalls).toHaveLength(3);
      expect(capturedAxiosCalls[0].method).toBe('GET');
      expect(capturedAxiosCalls[1].method).toBe('PUT');
      expect(capturedAxiosCalls[2].method).toBe('PUT');

      // CopyObject headers carry the source pointer and target class.
      expect(capturedAxiosCalls[1].headers['x-amz-copy-source']).toBe(
        '/mybucket/snap/a.dat'
      );
      expect(capturedAxiosCalls[1].headers['x-amz-storage-class']).toBe('GLACIER');
      expect(capturedAxiosCalls[1].headers['x-amz-metadata-directive']).toBe('COPY');
      expect(capturedAxiosCalls[2].headers['x-amz-copy-source']).toBe(
        '/mybucket/snap/c.dat'
      );

      // Both signed PUTs target the same bucket+key as their destination.
      expect(capturedAxiosCalls[1].url).toBe('https://mybucket.s3.amazonaws.com/snap/a.dat');
      expect(capturedAxiosCalls[2].url).toBe('https://mybucket.s3.amazonaws.com/snap/c.dat');
    });

    it('counts a copy returning >=400 as a per-object error', async () => {
      nextAxiosResponses.push({
        status: 200,
        data: JSON.stringify({
          ListBucketResult: {
            Contents: [
              { Key: 'snap/a.dat', Size: '1024', StorageClass: 'STANDARD' },
              { Key: 'snap/b.dat', Size: '1024', StorageClass: 'STANDARD' },
            ],
            IsTruncated: 'false',
          },
        }),
      });
      // First copy succeeds, second returns 403.
      nextAxiosResponses.push({ status: 200, data: '' });
      nextAxiosResponses.push({ status: 403, data: '<Error>...</Error>' });

      const storage = await storageClientFactory('aws', {
        accessKeyId: 'AK',
        secretAccessKey: 'SK',
        region: 'us-east-1',
      });
      const result = await storage.refreeze('mybucket', 'snap/', 'GLACIER');

      expect(result).toEqual({ refrozen: 1, skipped: 0, errors: 1 });
    });
  });

  describe('non-AWS providers', () => {
    it('throws for azure provider', async () => {
      await expect(storageClientFactory('azure')).rejects.toThrow(
        /Storage adapter for provider 'azure' is not implemented yet/
      );
    });

    it('throws for gcs provider', async () => {
      await expect(storageClientFactory('gcs')).rejects.toThrow(
        /Storage adapter for provider 'gcs' is not implemented yet/
      );
    });
  });
});
