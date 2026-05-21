/**
 * Cloud-storage adapter types used by Thaw / RepairMetadata.
 *
 * The deepfreeze plugin doesn't bundle every cloud-provider SDK — for
 * now only AWS S3 is implemented, with Azure / GCS adapters slotting
 * into the same `StorageClient` shape in a follow-up.
 *
 * Mirrors the abstract `S3Client` interface in
 *   packages/deepfreeze-core/deepfreeze_core/s3client.py
 * pared down to what Thaw + Rotate actually need: object listing, head
 * check, restore initiation, archive-tier transition, connection probe.
 * The broader bucket-lifecycle surface (create_bucket / delete_bucket /
 * put_object) stays in Python until we have a concrete use case for it
 * server-side.
 */

import type { Provider } from '../../common/constants';

/** One object returned by `listObjects`. */
export interface StorageObject {
  /** Full object key including any prefix. */
  key: string;
  /** Size in bytes. -1 when ES omits it (paginator edge case). */
  size: number;
  /**
   * Cloud-storage class. AWS values: STANDARD, INTELLIGENT_TIERING,
   * GLACIER, DEEP_ARCHIVE, etc. Empty string when the provider omits it.
   */
  storage_class: string;
}

/**
 * Live state of an object's restore progress, as returned by HEAD on
 * a Glacier-tier object.
 */
export interface ObjectRestoreState {
  /** Storage class of the object (same values as `StorageObject.storage_class`). */
  storage_class: string;
  /**
   * True when the object lives in a "hot" tier (STANDARD, INTELLIGENT_TIERING,
   * STANDARD_IA, ONEZONE_IA) and is immediately accessible — no restore needed.
   */
  accessible: boolean;
  /**
   * Restore state for archive-tier objects:
   *   - `null` when the object has no restore request on file,
   *   - `{ ongoing: true }` while the restore is in flight,
   *   - `{ ongoing: false, expiry_date }` once temporarily restored,
   *     with the date the copy will revert to Glacier.
   *
   * For objects in a hot tier, this is always `null` (see `accessible`).
   */
  restore: { ongoing: boolean; expiry_date?: string } | null;
}

/** Glacier retrieval tier — controls restore latency and price. */
export type RetrievalTier = 'Standard' | 'Expedited' | 'Bulk';

export interface RestoreOptions {
  /** How many days the temporary restore copy should remain available. */
  days: number;
  /** Defaults to 'Standard' (3–5 hr restore latency). */
  tier?: RetrievalTier;
}

/**
 * Per-object outcome counts returned by `refreeze`. Mirrors the
 * summary that `utilities.push_to_glacier` logs in the Python port.
 *
 * `refrozen` is the count of objects that were transitioned to the
 * target storage class. `skipped` is the count already in the target
 * class. `errors` is the count of per-object failures (the operation
 * continues past them; only catastrophic listing failures throw).
 */
export interface RefreezeResult {
  refrozen: number;
  skipped: number;
  errors: number;
}

/**
 * Common cloud-storage surface used by the deepfreeze action layer.
 *
 * Each method targets exactly the work Thaw / RepairMetadata need;
 * implementations are free to use whichever SDK calls suit their
 * provider. Operations that don't make sense for a given provider
 * (e.g. AWS storage_class for Azure) should be quietly ignored.
 */
export interface StorageClient {
  /** Lightweight probe that the configured credentials can reach `bucket`. */
  testConnection(bucket: string): Promise<boolean>;

  /**
   * Paginate the bucket's contents under `prefix`. Implementations
   * MUST handle pagination internally so callers see one flat list.
   */
  listObjects(bucket: string, prefix: string): Promise<StorageObject[]>;

  /** Inspect a single object's storage tier and restore state. */
  headObject(bucket: string, key: string): Promise<ObjectRestoreState>;

  /**
   * Issue a restore-from-archive request for one object. A no-op if
   * the object is already in a hot tier or has an active restore.
   * Implementations MUST resolve the same way whether the call was
   * a no-op or initiated a new restore so callers don't need to
   * disambiguate.
   */
  restoreObject(bucket: string, key: string, opts: RestoreOptions): Promise<void>;

  /**
   * Transition every object under `prefix` in `bucket` to
   * `storage_class`. Objects already in the target class are skipped.
   * Per-object failures are counted and the operation continues —
   * implementations only throw on catastrophic listing failures.
   *
   * AWS uses `CopyObject` with the source equal to the destination.
   * Provider equivalents (Azure tier change, GCS storage-class update)
   * land here when those adapters arrive.
   */
  refreeze(bucket: string, prefix: string, storage_class: string): Promise<RefreezeResult>;
}

/** Provider tag → adapter implementation. */
export type StorageClientFactory = (provider: Provider) => StorageClient;
