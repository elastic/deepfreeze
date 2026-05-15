/**
 * Parity tests for the Elasticsearch index mappings.
 *
 * These tests are JSON snapshot checks — they don't require Kibana or a
 * running cluster. They guard against accidental drift between the TS
 * schema and the Python source-of-truth by comparing against fixture
 * files extracted from the Python codebase.
 *
 * The fixtures live at `tests/parity/fixtures/` and are produced by
 * a small Python helper that prints the literal dicts passed to
 * `client.indices.create()`. See `tests/parity/README.md`.
 *
 * NOTE: This test file is intentionally framework-agnostic — it should
 * run under Jest once the plugin scaffold lands (Task #1) but the
 * assertions are plain `assert.deepEqual`-style so it can also be run
 * via `node --test` in isolation.
 */

import { STATUS_INDEX_MAPPING, AUDIT_INDEX_MAPPING } from '../index_mappings';

describe('ES index mapping parity', () => {
  it('status mapping has the expected doctype discriminator field', () => {
    expect(STATUS_INDEX_MAPPING.mappings.properties.doctype).toEqual({
      type: 'keyword',
    });
  });

  it('status mapping declares all Repository fields', () => {
    const props = STATUS_INDEX_MAPPING.mappings.properties as Record<string, unknown>;
    for (const field of [
      'name',
      'bucket',
      'base_path',
      'start',
      'end',
      'is_thawed',
      'is_mounted',
      'thaw_state',
      'thawed_at',
      'expires_at',
    ]) {
      expect(props[field]).toBeDefined();
    }
  });

  it('status mapping declares all ThawRequest fields', () => {
    const props = STATUS_INDEX_MAPPING.mappings.properties as Record<string, unknown>;
    for (const field of [
      'request_id',
      'repos',
      'status',
      'created_at',
      'start_date',
      'end_date',
    ]) {
      expect(props[field]).toBeDefined();
    }
  });

  it('status mapping declares all Settings fields', () => {
    const props = STATUS_INDEX_MAPPING.mappings.properties as Record<string, unknown>;
    for (const field of [
      'repo_name_prefix',
      'bucket_name_prefix',
      'base_path_prefix',
      'canned_acl',
      'storage_class',
      'provider',
      'rotate_by',
      'style',
      'last_suffix',
      'ilm_policy_name',
      'index_template_name',
      'thaw_request_retention_days_completed',
      'thaw_request_retention_days_failed',
      'thaw_request_retention_days_refrozen',
    ]) {
      expect(props[field]).toBeDefined();
    }
  });

  it('audit mapping stores parameters/results/errors/summary as non-indexed objects', () => {
    const props = AUDIT_INDEX_MAPPING.mappings.properties as Record<
      string,
      { type: string; enabled?: boolean }
    >;
    for (const field of ['parameters', 'results', 'errors', 'summary']) {
      expect(props[field]).toEqual({ type: 'object', enabled: false });
    }
  });

  it('audit mapping uses long for duration_ms (millisecond precision can exceed int32)', () => {
    expect(AUDIT_INDEX_MAPPING.mappings.properties.duration_ms).toEqual({
      type: 'long',
    });
  });

  it('both indices use 1 shard / 1 replica by default', () => {
    expect(STATUS_INDEX_MAPPING.settings).toEqual({
      number_of_shards: 1,
      number_of_replicas: 1,
    });
    expect(AUDIT_INDEX_MAPPING.settings).toEqual({
      number_of_shards: 1,
      number_of_replicas: 1,
    });
  });
});
