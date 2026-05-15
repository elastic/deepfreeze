/**
 * Elasticsearch index mappings for deepfreeze's two indices.
 *
 * **This is the compatibility contract**: the Python and TypeScript
 * implementations both write into these indices using these exact mappings.
 * Any change here must land simultaneously in the Python source files
 * referenced below.
 *
 * Sources of truth in Python:
 *   - deepfreeze-status:
 *       packages/deepfreeze-core/deepfreeze_core/utilities.py
 *       — ensure_settings_index()
 *   - deepfreeze-audit:
 *       packages/deepfreeze-core/deepfreeze_core/audit.py
 *       — AuditLogger.ensure_audit_index()
 *
 * The shape mirrors what is passed to `client.indices.create({ body: ... })`
 * in Python. When invoked through Kibana's `@elastic/elasticsearch` client,
 * pass these objects directly as the request body.
 */

export const STATUS_INDEX_MAPPING = {
  settings: {
    number_of_shards: 1,
    number_of_replicas: 1,
  },
  mappings: {
    properties: {
      doctype: { type: 'keyword' },
      name: {
        type: 'text',
        fields: { keyword: { type: 'keyword' } },
      },
      bucket: { type: 'keyword' },
      base_path: { type: 'keyword' },
      start: { type: 'date' },
      end: { type: 'date' },
      is_thawed: { type: 'boolean' },
      is_mounted: { type: 'boolean' },
      thaw_state: { type: 'keyword' },
      thawed_at: { type: 'date' },
      expires_at: { type: 'date' },
      request_id: { type: 'keyword' },
      repos: { type: 'keyword' },
      status: { type: 'keyword' },
      created_at: { type: 'date' },
      start_date: { type: 'date' },
      end_date: { type: 'date' },
      repo_name_prefix: { type: 'keyword' },
      bucket_name_prefix: { type: 'keyword' },
      base_path_prefix: { type: 'keyword' },
      canned_acl: { type: 'keyword' },
      storage_class: { type: 'keyword' },
      provider: { type: 'keyword' },
      rotate_by: { type: 'keyword' },
      style: { type: 'keyword' },
      last_suffix: { type: 'keyword' },
      ilm_policy_name: { type: 'keyword' },
      index_template_name: { type: 'keyword' },
      thaw_request_retention_days_completed: { type: 'integer' },
      thaw_request_retention_days_failed: { type: 'integer' },
      thaw_request_retention_days_refrozen: { type: 'integer' },
    },
  },
} as const;

export const AUDIT_INDEX_MAPPING = {
  settings: {
    number_of_shards: 1,
    number_of_replicas: 1,
  },
  mappings: {
    properties: {
      timestamp: { type: 'date' },
      action: { type: 'keyword' },
      dry_run: { type: 'boolean' },
      success: { type: 'boolean' },
      duration_ms: { type: 'long' },
      parameters: { type: 'object', enabled: false },
      results: { type: 'object', enabled: false },
      errors: { type: 'object', enabled: false },
      summary: { type: 'object', enabled: false },
      user: { type: 'keyword' },
      hostname: { type: 'keyword' },
      version: { type: 'keyword' },
    },
  },
} as const;
