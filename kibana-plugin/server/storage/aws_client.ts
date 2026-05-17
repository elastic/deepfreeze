/**
 * AWS S3 implementation of `StorageClient`.
 *
 * Mirrors `AwsS3Client.thaw` / `head_object` / `list_objects` in
 *   packages/deepfreeze-core/deepfreeze_core/aws_client.py
 *
 * Construction is decoupled from the real `@aws-sdk/client-s3`
 * package by accepting a minimal structural interface (`S3ClientApi`)
 * for the underlying SDK client. `storageClientFactory` wires the
 * real AWS SDK calls into this interface; tests pass a fake.
 */

import {
  type ObjectRestoreState,
  type RestoreOptions,
  type StorageClient,
  type StorageObject,
} from './types';

/**
 * Minimal shape of the @elastic-side wrapper around the AWS SDK v3
 * `S3Client`. Each method returns just the response body fields we
 * use; nothing here transitively requires the real SDK at build time.
 */
export interface S3ClientApi {
  listObjectsV2(params: {
    Bucket: string;
    Prefix: string;
    ContinuationToken?: string;
  }): Promise<{
    Contents?: Array<{
      Key?: string;
      Size?: number;
      StorageClass?: string;
    }>;
    NextContinuationToken?: string;
    IsTruncated?: boolean;
  }>;

  headObject(params: { Bucket: string; Key: string }): Promise<{
    StorageClass?: string;
    /**
     * Raw `x-amz-restore` response header. Two known formats:
     *   `ongoing-request="true"`
     *   `ongoing-request="false", expiry-date="Tue, 31 Dec 2026 00:00:00 GMT"`
     */
    Restore?: string;
  }>;

  restoreObject(params: {
    Bucket: string;
    Key: string;
    RestoreRequest: {
      Days: number;
      GlacierJobParameters?: { Tier: string };
    };
  }): Promise<unknown>;

  headBucket(params: { Bucket: string }): Promise<unknown>;
}

/**
 * Storage classes that don't need restore. Objects in these tiers are
 * always immediately accessible.
 *
 * Note: INTELLIGENT_TIERING auto-tiers between hot and archive; objects
 * already moved to its archive sub-tiers (Archive Access / Deep Archive
 * Access) DO need restore. AWS reports those as
 * `StorageClass: INTELLIGENT_TIERING` with a Restore header, so we
 * decide accessibility by Restore-header presence rather than class
 * alone for that one tier.
 */
const ALWAYS_HOT_CLASSES = new Set([
  'STANDARD',
  'STANDARD_IA',
  'ONEZONE_IA',
  'REDUCED_REDUNDANCY',
]);

/**
 * Parse the AWS S3 `x-amz-restore` response header.
 *
 * Returns `null` when the header is absent (no restore on file).
 */
export function parseRestoreHeader(
  header: string | undefined
): { ongoing: boolean; expiry_date?: string } | null {
  if (!header) return null;
  const ongoingMatch = /ongoing-request="(true|false)"/.exec(header);
  if (!ongoingMatch) return null;
  const ongoing = ongoingMatch[1] === 'true';
  const expiryMatch = /expiry-date="([^"]+)"/.exec(header);
  return expiryMatch ? { ongoing, expiry_date: expiryMatch[1] } : { ongoing };
}

export class AwsStorageClient implements StorageClient {
  constructor(private readonly s3: S3ClientApi) {}

  async testConnection(bucket: string): Promise<boolean> {
    try {
      await this.s3.headBucket({ Bucket: bucket });
      return true;
    } catch {
      return false;
    }
  }

  async listObjects(bucket: string, prefix: string): Promise<StorageObject[]> {
    const results: StorageObject[] = [];
    let token: string | undefined;
    do {
      const resp = await this.s3.listObjectsV2({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
      });
      for (const obj of resp.Contents ?? []) {
        if (!obj.Key) continue;
        results.push({
          key: obj.Key,
          size: obj.Size ?? -1,
          storage_class: obj.StorageClass ?? '',
        });
      }
      token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (token);
    return results;
  }

  async headObject(bucket: string, key: string): Promise<ObjectRestoreState> {
    const resp = await this.s3.headObject({ Bucket: bucket, Key: key });
    const storage_class = resp.StorageClass ?? 'STANDARD';
    const restore = parseRestoreHeader(resp.Restore);

    // Hot tiers: always accessible. Glacier/Deep Archive: accessible
    // only once restore is complete (ongoing === false). Intelligent
    // Tiering with no Restore header is still hot.
    let accessible: boolean;
    if (ALWAYS_HOT_CLASSES.has(storage_class)) {
      accessible = true;
    } else if (storage_class === 'INTELLIGENT_TIERING' && !restore) {
      accessible = true;
    } else if (restore && restore.ongoing === false) {
      accessible = true;
    } else {
      accessible = false;
    }

    return { storage_class, accessible, restore };
  }

  async restoreObject(bucket: string, key: string, opts: RestoreOptions): Promise<void> {
    // Check first; AWS will return InvalidObjectState if the object is
    // already in a hot tier, or RestoreAlreadyInProgress when a restore
    // is already running. Both are no-ops from our perspective.
    const state = await this.headObject(bucket, key);
    if (state.accessible || (state.restore && state.restore.ongoing)) {
      return;
    }

    await this.s3.restoreObject({
      Bucket: bucket,
      Key: key,
      RestoreRequest: {
        Days: opts.days,
        GlacierJobParameters: { Tier: opts.tier ?? 'Standard' },
      },
    });
  }
}
