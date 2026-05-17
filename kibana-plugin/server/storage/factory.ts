/**
 * Construct a real `StorageClient` for the configured provider.
 *
 * The factory is the *only* file in `server/storage/` that imports
 * the AWS SDK directly. Adapters (`aws_client.ts`) target a structural
 * `S3ClientApi` interface so the heavy SDK dependency stays at the
 * integration boundary — tests can build adapters against fakes
 * without pulling in `@aws-sdk/client-s3` at all.
 */

import type { Provider } from '../../common/constants';
import { AwsStorageClient, type S3ClientApi } from './aws_client';
import type { StorageClient } from './types';

export interface AwsStorageClientOptions {
  /**
   * AWS region. When omitted, the SDK resolves via the standard
   * credential/config chain (AWS_REGION env var, shared config).
   */
  region?: string;
  /**
   * Custom S3 endpoint override (LocalStack, MinIO, custom domain).
   * Omit for the default AWS endpoint.
   */
  endpoint?: string;
  /**
   * Force path-style addressing (s3.amazonaws.com/bucket/key) instead
   * of virtual-host (bucket.s3.amazonaws.com/key). Defaults off; turn
   * on for LocalStack/MinIO.
   */
  forcePathStyle?: boolean;
}

/**
 * Wrap the real `@aws-sdk/client-s3` `S3Client` into our structural
 * `S3ClientApi`. The SDK is imported lazily inside this function so
 * the rest of the storage layer compiles without it (useful for the
 * test build / unit tests / type-check on a non-bootstrapped checkout).
 */
async function buildAwsS3Api(opts: AwsStorageClientOptions): Promise<S3ClientApi> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sdk = (await import('@aws-sdk/client-s3')) as typeof import('@aws-sdk/client-s3');
  const client = new sdk.S3Client({
    region: opts.region,
    endpoint: opts.endpoint,
    forcePathStyle: opts.forcePathStyle,
  });

  return {
    listObjectsV2: async (params) => {
      const resp = await client.send(new sdk.ListObjectsV2Command(params));
      return {
        Contents: resp.Contents?.map((c) => ({
          Key: c.Key,
          Size: c.Size,
          StorageClass: c.StorageClass,
        })),
        NextContinuationToken: resp.NextContinuationToken,
        IsTruncated: resp.IsTruncated,
      };
    },
    headObject: async (params) => {
      const resp = await client.send(new sdk.HeadObjectCommand(params));
      return { StorageClass: resp.StorageClass, Restore: resp.Restore };
    },
    restoreObject: async (params) => {
      // AWS SDK types `Tier` as the literal union 'Standard'|'Expedited'|'Bulk',
      // but our structural S3ClientApi keeps it loose so adapters don't depend
      // on importing the SDK. Cast at the boundary.
      return client.send(
        new sdk.RestoreObjectCommand(
          params as ConstructorParameters<typeof sdk.RestoreObjectCommand>[0]
        )
      );
    },
    headBucket: async (params) => {
      return client.send(new sdk.HeadBucketCommand(params));
    },
  };
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
  const api = await buildAwsS3Api(options);
  return new AwsStorageClient(api);
}
