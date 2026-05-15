/**
 * Idempotent creators for the two deepfreeze Elasticsearch indices.
 *
 * Replaces (the parts that need replacing of):
 *   - packages/deepfreeze-core/deepfreeze_core/utilities.py
 *     — ensure_settings_index()
 *   - packages/deepfreeze-core/deepfreeze_core/audit.py
 *     — AuditLogger.ensure_audit_index()
 *
 * The Python `esclient.py` itself has no TS counterpart: Kibana plugins
 * receive a configured Elasticsearch client from
 * `core.elasticsearch.client` and do not build their own. Auth mode
 * selection (basic / api_key / cloud_id / mutual TLS) is handled by
 * Kibana's `elasticsearch.*` config at the platform level.
 *
 * These helpers accept a generic structural client type rather than
 * `@kbn/core/server`'s `ElasticsearchClient` so they can be unit-tested
 * without pulling in Kibana types. The Kibana client satisfies this
 * interface (it's a subset of `@elastic/elasticsearch`'s `Client`).
 */

import {
  AUDIT_INDEX,
  STATUS_INDEX,
} from '../../common/constants';
import {
  AUDIT_INDEX_MAPPING,
  STATUS_INDEX_MAPPING,
} from '../../common/schemas/index_mappings';

/**
 * Minimal structural interface for the ES client methods we use.
 * Both `@kbn/core`'s `ElasticsearchClient` and `@elastic/elasticsearch`'s
 * `Client` satisfy this shape.
 */
export interface IndexAwareEsClient {
  indices: {
    exists: (params: { index: string }) => Promise<boolean> | boolean;
    create: (params: {
      index: string;
      // Kibana 9 / ES 9 use top-level `settings` + `mappings`; older
      // clients accept them inside `body`. We pass top-level which is
      // accepted by both contemporary client versions.
      settings?: Record<string, unknown>;
      mappings?: Record<string, unknown>;
    }) => Promise<unknown>;
  };
}

export type EnsureIndexResult = 'created' | 'already_exists';

/**
 * Create `deepfreeze-status` with the locked mapping if it doesn't exist.
 *
 * @returns 'created' if a new index was made, 'already_exists' otherwise.
 */
export async function ensureStatusIndex(
  client: IndexAwareEsClient
): Promise<EnsureIndexResult> {
  const exists = await client.indices.exists({ index: STATUS_INDEX });
  if (exists) {
    return 'already_exists';
  }
  await client.indices.create({
    index: STATUS_INDEX,
    settings: STATUS_INDEX_MAPPING.settings,
    mappings: STATUS_INDEX_MAPPING.mappings,
  });
  return 'created';
}

/**
 * Create `deepfreeze-audit` with the locked mapping if it doesn't exist.
 *
 * Matches the fail-soft semantics of Python's
 * `AuditLogger.ensure_audit_index()`: callers can choose to swallow
 * errors here so that audit-logging never breaks the underlying action.
 */
export async function ensureAuditIndex(
  client: IndexAwareEsClient
): Promise<EnsureIndexResult> {
  const exists = await client.indices.exists({ index: AUDIT_INDEX });
  if (exists) {
    return 'already_exists';
  }
  await client.indices.create({
    index: AUDIT_INDEX,
    settings: AUDIT_INDEX_MAPPING.settings,
    mappings: AUDIT_INDEX_MAPPING.mappings,
  });
  return 'created';
}
