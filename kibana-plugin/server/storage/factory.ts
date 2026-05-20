/**
 * Construct a real `StorageClient` for the configured provider.
 *
 * The factory is the *only* file in `server/storage/` that imports
 * cloud-provider HTTP clients directly. Adapters (`aws_client.ts`)
 * target a structural `S3ClientApi` interface so the heavy
 * integration code stays at this boundary — tests can build adapters
 * against fakes without importing `aws4` / `axios` at all.
 *
 * Implementation note: this used to wrap `@aws-sdk/client-s3`. That
 * package isn't in upstream Kibana, and adding it would have made the
 * Phase 7 PR a hard sell. We now use `aws4` (already vendored upstream
 * for the Bedrock connector) to SigV4-sign raw REST calls and `axios`
 * (also already vendored) to send them. Same surface area, zero new
 * Kibana root dependencies.
 */

import type { Provider } from '../../common/constants';
import { AwsStorageClient, type S3ClientApi } from './aws_client';
import type { StorageClient } from './types';

// `aws4`, `axios`, and `fast-xml-parser` are all in upstream Kibana's
// root `package.json` but are NOT installed in this standalone
// `kibana-plugin/` workspace's `node_modules`. We load them lazily so
// the broader test suite — which never actually constructs a real
// storage client — can compile and run without those installs. The
// loaded modules are cached after the first call.
//
// Types are sourced from `@types/aws4` / `axios` via Kibana's tsconfig
// once the plugin is synced into the Kibana checkout; the standalone
// `tsconfig.test.json` skips type-checking the factory's bodies.

type Aws4Sign = (request: unknown, credentials: unknown) => { headers: Record<string, string> };
interface AxiosLike {
  request(config: unknown): Promise<{
    status: number;
    data: unknown;
    headers?: Record<string, unknown>;
  }>;
}
interface XmlParser {
  parse(input: string): unknown;
}

interface ResolvedCredentials {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

type CredentialProvider = () => Promise<ResolvedCredentials>;

let cachedAws4: { sign: Aws4Sign } | undefined;
let cachedAxios: AxiosLike | undefined;
let cachedXmlParser: XmlParser | undefined;
let cachedDefaultProvider: CredentialProvider | undefined;

async function loadAws4(): Promise<{ sign: Aws4Sign }> {
  if (cachedAws4) return cachedAws4;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = (await import('aws4')) as unknown as { default?: { sign: Aws4Sign }; sign?: Aws4Sign };
  const sign = mod.default?.sign ?? mod.sign;
  if (!sign) throw new Error('aws4 module missing `sign` export');
  cachedAws4 = { sign };
  return cachedAws4;
}

async function loadAxios(): Promise<AxiosLike> {
  if (cachedAxios) return cachedAxios;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = (await import('axios')) as unknown as { default?: AxiosLike } & AxiosLike;
  cachedAxios = mod.default ?? mod;
  return cachedAxios;
}

async function loadXmlParser(): Promise<XmlParser> {
  if (cachedXmlParser) return cachedXmlParser;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = (await import('fast-xml-parser')) as unknown as {
    XMLParser: new (opts: unknown) => XmlParser;
  };
  cachedXmlParser = new mod.XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    isArray: (name: string) => name === 'Contents',
  });
  return cachedXmlParser;
}

/**
 * Resolve ambient AWS credentials via the SDK's standard chain
 * (env vars → ~/.aws/credentials → EC2/ECS IMDS → SSO → web identity).
 * `@aws-sdk/credential-provider-node` is already in upstream Kibana
 * as a transitive dep of the Bedrock connector family, so this is
 * zero new Kibana root deps.
 */
async function loadDefaultProvider(): Promise<CredentialProvider> {
  if (cachedDefaultProvider) return cachedDefaultProvider;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = (await import('@aws-sdk/credential-provider-node')) as unknown as {
    defaultProvider: (init?: unknown) => () => Promise<ResolvedCredentials>;
  };
  cachedDefaultProvider = mod.defaultProvider();
  return cachedDefaultProvider;
}

export interface AwsStorageClientOptions {
  /**
   * AWS access key. Sourced from the Kibana keystore via
   * `xpack.deepfreeze.aws.accessKeyId`. Required for live calls; tests
   * pass any non-empty string.
   */
  accessKeyId?: string;
  /**
   * AWS secret access key. Keystore-only.
   */
  secretAccessKey?: string;
  /**
   * AWS session token. Optional; only needed for temporary credentials.
   */
  sessionToken?: string;
  /**
   * AWS region (e.g. `us-east-1`). When omitted, defaults to
   * `us-east-1` — matches the SDK's behavior when no region is set.
   */
  region?: string;
  /**
   * Custom S3 endpoint override (LocalStack, MinIO, custom domain).
   * Omit for the default AWS endpoint resolution.
   *
   * Accepts either a bare host (`localhost:4566`) or a full URL
   * (`http://localhost:4566`). Bare hosts get `https://` prepended.
   */
  endpoint?: string;
  /**
   * Force path-style addressing (`<endpoint>/<bucket>/<key>`) instead
   * of virtual-host (`<bucket>.<endpoint>/<key>`). Defaults off; turn
   * on for LocalStack/MinIO.
   */
  forcePathStyle?: boolean;
}

const DEFAULT_REGION = 'us-east-1';
const SERVICE = 's3';

/**
 * Resolve `{ host, basePath }` for a bucket given the configured
 * endpoint / region / addressing-style. `basePath` is the URL prefix
 * before the object key — empty for virtual-host, `/<bucket>` for
 * path-style.
 */
function resolveEndpoint(
  bucket: string,
  opts: AwsStorageClientOptions
): { protocol: string; host: string; basePath: string } {
  let protocol = 'https';
  let host: string;

  if (opts.endpoint) {
    const raw = opts.endpoint.includes('://')
      ? opts.endpoint
      : `https://${opts.endpoint}`;
    const url = new URL(raw);
    protocol = url.protocol.replace(/:$/, '');
    host = url.host;
  } else {
    const region = opts.region ?? DEFAULT_REGION;
    host = region === 'us-east-1' ? 's3.amazonaws.com' : `s3.${region}.amazonaws.com`;
  }

  if (opts.forcePathStyle) {
    return { protocol, host, basePath: `/${encodeURIComponent(bucket)}` };
  }
  return { protocol, host: `${bucket}.${host}`, basePath: '' };
}

/**
 * Build a signed request and send it via axios. Returns the raw axios
 * response so callers can inspect headers (HeadObject) or status
 * (RestoreObject) directly.
 *
 * `validateStatus: () => true` so 404 / 304 don't throw — adapter code
 * checks status explicitly. axios's default-throw-on-non-2xx behavior
 * makes the surrounding business logic awkward.
 */
interface SignedResponse {
  status: number;
  data: unknown;
  headers?: Record<string, unknown>;
}

async function signedRequest(
  opts: AwsStorageClientOptions,
  args: {
    method: string;
    bucket: string;
    key?: string;
    query?: Record<string, string | undefined>;
    body?: string;
    headers?: Record<string, string>;
  }
): Promise<SignedResponse> {
  const { protocol, host, basePath } = resolveEndpoint(args.bucket, opts);

  // Keep empty-string values: S3 sub-resource markers like `?restore`
  // are sent as bare keys, but `aws4` canonicalizes them as `key=` and
  // expects the same in the path. Drop only `undefined`.
  const queryString = args.query
    ? Object.entries(args.query)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v!)}`)
        .join('&')
    : '';

  // S3 expects un-encoded slashes between key segments but encoded
  // special characters within each segment. `encodeURI` is the right
  // balance: encodes spaces and other non-ASCII while leaving `/` alone.
  const keyPath = args.key ? `/${encodeURI(args.key)}` : '';
  // Compose the path. basePath is either empty (virtual-host) or
  // `/<bucket>` (path-style). Fallback to `/` when both are empty so
  // SigV4 canonicalization gets a leading slash.
  const rawPath = `${basePath}${keyPath}` || '/';
  const path = `${rawPath}${queryString ? `?${queryString}` : ''}`;

  const region =
    opts.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? DEFAULT_REGION;
  const aws4 = await loadAws4();
  const axiosClient = await loadAxios();
  const credentials = await resolveCredentials(opts);

  const signed = aws4.sign(
    {
      host,
      path,
      method: args.method,
      service: SERVICE,
      region,
      headers: args.headers ?? {},
      body: args.body,
    },
    credentials
  );

  return axiosClient.request({
    url: `${protocol}://${host}${path}`,
    method: args.method,
    headers: signed.headers,
    data: args.body,
    // S3 responses can be XML, plain text, or empty. We parse XML
    // ourselves so axios shouldn't try to interpret response bodies.
    responseType: 'text',
    transformResponse: (data: unknown) => data,
    validateStatus: () => true,
    maxRedirects: 0,
  }) as Promise<SignedResponse>;
}

/**
 * Construct the structural `S3ClientApi` wrapper used by
 * `AwsStorageClient`. Each method translates a call into an SigV4-
 * signed REST request and parses the response shape down to just the
 * fields the adapter actually needs.
 */
function buildAwsS3Api(opts: AwsStorageClientOptions): S3ClientApi {
  return {
    listObjectsV2: async (params) => {
      const resp = await signedRequest(opts, {
        method: 'GET',
        bucket: params.Bucket,
        query: {
          'list-type': '2',
          // Drop empty prefix so we don't send `?prefix=` (harmless but
          // noisy in the URL and in signatures). Undefined values get
          // filtered out by `signedRequest`.
          prefix: params.Prefix ? params.Prefix : undefined,
          'continuation-token': params.ContinuationToken,
        },
      });
      if (resp.status >= 400) {
        throw new Error(
          `S3 ListObjectsV2 ${params.Bucket} failed with status ${resp.status}: ${String(resp.data)}`
        );
      }
      const xmlParser = await loadXmlParser();
      const parsed = xmlParser.parse(String(resp.data ?? '')) as {
        ListBucketResult?: {
          Contents?: Array<{ Key?: string; Size?: string; StorageClass?: string }>;
          NextContinuationToken?: string;
          IsTruncated?: string;
        };
      };
      const result = parsed.ListBucketResult ?? {};
      return {
        Contents: result.Contents?.map((c) => ({
          Key: c.Key,
          Size: c.Size !== undefined ? Number(c.Size) : undefined,
          StorageClass: c.StorageClass,
        })),
        NextContinuationToken: result.NextContinuationToken,
        IsTruncated: result.IsTruncated === 'true',
      };
    },

    headObject: async (params) => {
      const resp = await signedRequest(opts, {
        method: 'HEAD',
        bucket: params.Bucket,
        key: params.Key,
      });
      if (resp.status === 404) {
        throw new Error(`S3 HeadObject ${params.Bucket}/${params.Key} not found`);
      }
      if (resp.status >= 400) {
        throw new Error(
          `S3 HeadObject ${params.Bucket}/${params.Key} failed with status ${resp.status}`
        );
      }
      return {
        StorageClass: getHeader(resp, 'x-amz-storage-class'),
        Restore: getHeader(resp, 'x-amz-restore'),
      };
    },

    restoreObject: async (params) => {
      const body =
        `<RestoreRequest xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
        `<Days>${params.RestoreRequest.Days}</Days>` +
        (params.RestoreRequest.GlacierJobParameters
          ? `<GlacierJobParameters><Tier>${escapeXml(
              params.RestoreRequest.GlacierJobParameters.Tier
            )}</Tier></GlacierJobParameters>`
          : '') +
        `</RestoreRequest>`;

      const resp = await signedRequest(opts, {
        method: 'POST',
        bucket: params.Bucket,
        key: params.Key,
        query: { restore: '' },
        body,
        headers: {
          'Content-Type': 'application/xml',
          'Content-Length': String(Buffer.byteLength(body)),
        },
      });

      // 202 Accepted: restore initiated. 200 OK: restore already
      // in progress (idempotent). 409: object is not in an archive
      // tier. Anything else is an error.
      if (resp.status !== 200 && resp.status !== 202) {
        throw new Error(
          `S3 RestoreObject ${params.Bucket}/${params.Key} failed with status ${resp.status}: ${String(resp.data)}`
        );
      }
      return undefined;
    },

    headBucket: async (params) => {
      const resp = await signedRequest(opts, {
        method: 'HEAD',
        bucket: params.Bucket,
      });
      if (resp.status >= 400) {
        throw new Error(
          `S3 HeadBucket ${params.Bucket} failed with status ${resp.status}`
        );
      }
      return undefined;
    },
  };
}

/**
 * Case-insensitive header lookup. axios normalizes header keys to
 * lowercase, but defensively support either casing in case a custom
 * transport is wired up by tests.
 */
function getHeader(resp: SignedResponse, name: string): string | undefined {
  const headers = resp.headers;
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return typeof v === 'string' ? v : String(v);
  }
  return undefined;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Resolve the credentials used to sign a request.
 *
 * Precedence:
 *   1. Explicit values from plugin config (Kibana keystore via
 *      `xpack.deepfreeze.aws.{accessKeyId,secretAccessKey,sessionToken}`).
 *      Wins outright when *both* key & secret are present.
 *   2. AWS SDK default provider chain (env vars → shared config →
 *      EC2/ECS IMDS → SSO → web identity).
 *
 * Matches the behavior of the prior `@aws-sdk/client-s3` adapter so
 * ops/devs running Kibana with `AWS_ACCESS_KEY_ID` exported, an
 * `~/.aws/credentials` profile, or an EC2 instance role keep working
 * without configuring anything in the Kibana keystore.
 */
async function resolveCredentials(
  opts: AwsStorageClientOptions
): Promise<ResolvedCredentials> {
  if (opts.accessKeyId && opts.secretAccessKey) {
    return {
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      sessionToken: opts.sessionToken,
    };
  }
  const provider = await loadDefaultProvider();
  return provider();
}

/**
 * Build a `StorageClient` for the given provider. AWS is the only
 * provider implemented right now; Azure / GCP throw a clear error
 * pointing at the missing adapter so the action layer can surface
 * a structured 'not yet supported' response.
 */
export async function storageClientFactory(
  provider: Provider,
  options: AwsStorageClientOptions = {}
): Promise<StorageClient> {
  if (provider !== 'aws') {
    throw new Error(
      `Storage adapter for provider '${provider}' is not implemented yet. ` +
        'Only AWS is supported in the current Kibana plugin build; Azure and GCS will land in a follow-on phase.'
    );
  }
  const api = buildAwsS3Api(options);
  return new AwsStorageClient(api);
}
