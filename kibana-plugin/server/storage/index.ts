export {
  AwsStorageClient,
  parseRestoreHeader,
  type S3ClientApi,
} from './aws_client';
export { storageClientFactory, type AwsStorageClientOptions } from './factory';
export type {
  ObjectRestoreState,
  RestoreOptions,
  RetrievalTier,
  StorageClient,
  StorageClientFactory,
  StorageObject,
} from './types';
