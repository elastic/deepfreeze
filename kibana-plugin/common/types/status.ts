/**
 * Status response shapes — what /api/deepfreeze/status and related
 * read-only routes return.
 *
 * Mirrors:
 *   packages/deepfreeze-server/deepfreeze_server/models/status.py
 *
 * The repository / thaw-request / settings / ILM-policy / bucket
 * sub-shapes are intentionally loose (`Record<string, unknown>` arrays)
 * to match the Python server, which assembles them from heterogeneous
 * sources. The strongly-typed document interfaces live under
 * `common/schemas/`.
 */

import type { RepositoryDoc } from '../schemas/repository';
import type { ThawRequestDoc } from '../schemas/thaw_request';
import type { SettingsDoc } from '../schemas/settings';
import type { ServiceError } from './errors';

export interface ClusterHealth {
  name: string;
  status: 'green' | 'yellow' | 'red' | 'unknown';
  version: string;
  node_count: number;
}

export interface BucketInfo {
  name: string;
  provider: string;
  region?: string;
  exists?: boolean;
  [key: string]: unknown;
}

export interface IlmPolicyInfo {
  name: string;
  [key: string]: unknown;
}

export interface SystemStatus {
  cluster: ClusterHealth;
  settings: SettingsDoc | null;
  repositories: RepositoryDoc[];
  thaw_requests: ThawRequestDoc[];
  buckets: BucketInfo[];
  ilm_policies: IlmPolicyInfo[];
  initialized: boolean;
  errors: ServiceError[];
  timestamp: string;
}

export interface ActionHistoryEntry {
  timestamp: string;
  action: string;
  dry_run: boolean;
  success: boolean;
  summary: string;
  error_count: number;
}
