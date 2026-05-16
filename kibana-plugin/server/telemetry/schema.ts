import type { MakeSchemaFrom } from '@kbn/usage-collection-plugin/server';
import type { DeepfreezeUsageData } from './types';

export const deepfreezeUsageSchema: MakeSchemaFrom<DeepfreezeUsageData> = {
  initialized: {
    type: 'boolean',
    _meta: { description: 'Whether a deepfreeze settings document exists in the cluster.' },
  },
  provider: {
    type: 'keyword',
    _meta: { description: "Cloud provider: 'aws', 'azure', 'gcp', or 'unknown'." },
  },
  rotate_by: {
    type: 'keyword',
    _meta: { description: "Rotation grouping: 'path', 'bucket', or 'unknown'." },
  },
  style: {
    type: 'keyword',
    _meta: { description: "Rotation style: 'oneup', 'date', or 'unknown'." },
  },

  repositories_total: {
    type: 'long',
    _meta: { description: 'Total number of deepfreeze-managed repositories.' },
  },
  repositories_active: { type: 'long', _meta: { description: 'Repositories in active state.' } },
  repositories_frozen: { type: 'long', _meta: { description: 'Repositories in frozen state.' } },
  repositories_thawing: { type: 'long', _meta: { description: 'Repositories in thawing state.' } },
  repositories_thawed: { type: 'long', _meta: { description: 'Repositories in thawed state.' } },
  repositories_expired: { type: 'long', _meta: { description: 'Repositories in expired state.' } },
  repositories_mounted: {
    type: 'long',
    _meta: { description: 'Repositories currently mounted as snapshot repositories.' },
  },

  thaw_requests_total: {
    type: 'long',
    _meta: { description: 'Total number of thaw requests on record.' },
  },
  thaw_requests_in_progress: {
    type: 'long',
    _meta: { description: 'Thaw requests with in_progress status.' },
  },
  thaw_requests_completed: {
    type: 'long',
    _meta: { description: 'Thaw requests with completed status.' },
  },
  thaw_requests_failed: {
    type: 'long',
    _meta: { description: 'Thaw requests with failed status.' },
  },
  thaw_requests_refrozen: {
    type: 'long',
    _meta: { description: 'Thaw requests with refrozen status.' },
  },
};
