/**
 * Audit tracker result/error entries.
 *
 * Mirrors the @dataclass ActionResult / ActionError in
 *   packages/deepfreeze-core/deepfreeze_core/audit.py
 *
 * `ActionError` is the audit-log entry shape — distinct from the
 * `ServiceError` type that flows over HTTP (`common/types/errors.ts`)
 * and from the `ActionError` exception class in deepfreeze_core.
 */

export interface ActionResult {
  type: string;
  action: string;
  target?: string;
  status?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AuditActionError {
  code: string;
  message: string;
  target?: string;
  [key: string]: unknown;
}

/**
 * Minimal structural ES client interface for audit operations.
 * `@kbn/core/server`'s `ElasticsearchClient` and `@elastic/elasticsearch`'s
 * `Client` both satisfy this shape.
 */
export interface AuditEsClient {
  indices: {
    exists: (params: { index: string }) => Promise<boolean> | boolean;
    create: (params: {
      index: string;
      settings?: Record<string, unknown>;
      mappings?: Record<string, unknown>;
    }) => Promise<unknown>;
  };
  index: (params: { index: string; document: object }) => Promise<unknown>;
  search: (params: {
    index: string;
    query?: Record<string, unknown>;
    sort?: unknown;
    size?: number;
  }) => Promise<{ hits: { hits: Array<{ _source: Record<string, unknown> }> } }>;
}
