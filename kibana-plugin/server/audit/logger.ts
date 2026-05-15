import { AUDIT_INDEX } from '../../common/constants';
import { ensureAuditIndex } from '../es/index_bootstrap';
import { ActionTracker } from './tracker';
import type { AuditEsClient } from './types';
import type { AuditEntryDoc } from '../../common/schemas/audit_entry';

/**
 * Optional dependencies and identity info captured on each audit row.
 *
 * In the Python implementation these were sourced from `os.environ` and
 * `socket.gethostname()`. In the Kibana plugin the equivalents come from
 * the request context (Kibana provides the authenticated user) and the
 * plugin's own version metadata — so we accept them as constructor
 * options rather than auto-detecting.
 */
export interface AuditLoggerOptions {
  /** When false, all logging methods are no-ops. Default: true. */
  enabled?: boolean;
  /** Plugin version string included in every audit row. Default: 'unknown'. */
  version?: string;
  /** Hostname / node identifier included in every audit row. Default: 'kibana'. */
  hostname?: string;
  /**
   * Optional logger sink for the fail-silent warning path. Kibana plugins
   * pass `logger.get('audit')` here. Defaults to a no-op so unit tests
   * stay quiet.
   */
  log?: {
    debug: (msg: string) => void;
    warn: (msg: string) => void;
  };
}

const NOOP_LOG = {
  debug: () => {},
  warn: () => {},
};

/**
 * Writes audit rows for mutating deepfreeze actions to the
 * `deepfreeze-audit` index.
 *
 * Mirrors `AuditLogger` in
 *   packages/deepfreeze-core/deepfreeze_core/audit.py
 *
 * Fail-silent contract is preserved: failures inside `logAction` /
 * `commit` / `track` never throw to callers — audit logging must not
 * break the underlying action.
 *
 * Differences from the Python implementation:
 *   - `user` is supplied per-call (Kibana plugin knows the request
 *     identity); there is no environment-based fallback.
 *   - The `track()` method is an async wrapper rather than a context
 *     manager. Errors thrown inside the callback are recorded on the
 *     tracker, the audit row is still committed, and the original
 *     error is re-thrown — same semantics as Python's `with` block.
 */
export class AuditLogger {
  private readonly client: AuditEsClient;
  private readonly enabled: boolean;
  private readonly version: string;
  private readonly hostname: string;
  private readonly log: NonNullable<AuditLoggerOptions['log']>;

  constructor(client: AuditEsClient, options: AuditLoggerOptions = {}) {
    this.client = client;
    this.enabled = options.enabled ?? true;
    this.version = options.version ?? 'unknown';
    this.hostname = options.hostname ?? 'kibana';
    this.log = options.log ?? NOOP_LOG;
  }

  /**
   * Idempotently create the audit index with the locked mapping.
   * Returns true if the index exists or was created, false on error.
   */
  async ensureAuditIndex(): Promise<boolean> {
    if (!this.enabled) {
      return false;
    }
    try {
      await ensureAuditIndex(this.client);
      return true;
    } catch (err) {
      this.log.warn(`Failed to create audit index: ${stringifyError(err)}`);
      return false;
    }
  }

  /**
   * Write a single audit row. Fails silently on any ES error.
   *
   * @returns true on successful index, false otherwise.
   */
  async logAction(entry: {
    action: string;
    dryRun: boolean;
    success: boolean;
    durationMs: number;
    parameters: Record<string, unknown>;
    results: unknown[];
    errors: unknown[];
    summary?: Record<string, unknown> | null;
    user: string;
  }): Promise<boolean> {
    if (!this.enabled) {
      return false;
    }

    try {
      await this.ensureAuditIndex();

      const doc: AuditEntryDoc = {
        timestamp: new Date().toISOString(),
        action: entry.action,
        dry_run: entry.dryRun,
        success: entry.success,
        duration_ms: entry.durationMs,
        parameters: entry.parameters,
        results: entry.results,
        errors: entry.errors,
        summary: entry.summary ?? {},
        user: entry.user,
        hostname: this.hostname,
        version: this.version,
      };

      await this.client.index({ index: AUDIT_INDEX, document: doc });
      this.log.debug(`Logged ${entry.action} action to audit index`);
      return true;
    } catch (err) {
      this.log.warn(`Failed to log audit entry: ${stringifyError(err)}`);
      return false;
    }
  }

  /** Begin tracking an action; caller is responsible for calling `commit`. */
  startTracking(
    action: string,
    dryRun: boolean,
    parameters: Record<string, unknown>
  ): ActionTracker {
    return new ActionTracker(action, dryRun, parameters);
  }

  /** Write the audit row described by `tracker`. */
  commit(tracker: ActionTracker, user: string): Promise<boolean> {
    return this.logAction({
      action: tracker.action,
      dryRun: tracker.dryRun,
      success: tracker.success,
      durationMs: tracker.durationMs,
      parameters: tracker.parameters,
      results: tracker.results,
      errors: tracker.errors,
      summary: tracker.summary,
      user,
    });
  }

  /**
   * Run `fn` with a tracker, commit the audit row whether `fn` resolves
   * or rejects, and re-throw on rejection.
   *
   * Equivalent to the Python `with audit.track(...) as tracker:` form.
   */
  async track<T>(
    options: {
      action: string;
      dryRun: boolean;
      parameters: Record<string, unknown>;
      user: string;
    },
    fn: (tracker: ActionTracker) => Promise<T>
  ): Promise<T> {
    const tracker = this.startTracking(options.action, options.dryRun, options.parameters);
    try {
      const result = await fn(tracker);
      tracker.markSuccess();
      return result;
    } catch (err) {
      tracker.markFailed();
      throw err;
    } finally {
      await this.commit(tracker, options.user);
    }
  }

  /**
   * Fetch the most recent audit rows, newest first. Read-only — used by
   * the activity / history UI.
   */
  async getRecentEntries(
    options: { limit?: number; actionFilter?: string } = {}
  ): Promise<AuditEntryDoc[]> {
    if (!this.enabled) {
      return [];
    }
    const limit = options.limit ?? 25;

    try {
      const exists = await this.client.indices.exists({ index: AUDIT_INDEX });
      if (!exists) {
        return [];
      }

      const query = options.actionFilter
        ? { term: { action: options.actionFilter } }
        : { match_all: {} };

      const response = await this.client.search({
        index: AUDIT_INDEX,
        query,
        sort: [{ timestamp: { order: 'desc' } }],
        size: limit,
      });

      return response.hits.hits.map((hit) => hit._source as unknown as AuditEntryDoc);
    } catch (err) {
      this.log.warn(`Failed to fetch audit entries: ${stringifyError(err)}`);
      return [];
    }
  }
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
