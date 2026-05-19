/**
 * One-time data migration: copy `scheduled_job` docs out of the legacy
 * `deepfreeze-status` index into Kibana SavedObjects, then delete the
 * legacy docs.
 *
 * Runs in `plugin.start` before `bootstrapDeepfreezeSchedules`. Safe
 * to re-run: the SO upsert and the legacy doc delete are both
 * idempotent. Clusters that never had a legacy doc finish immediately.
 *
 * Intentionally narrow: this migration only handles scheduled_job
 * docs. Other deepfreeze doctypes (repository, thaw_request,
 * audit_entry) keep their current homes — they have a different
 * access pattern (route-handler, user-scoped) where the legacy index
 * isn't a problem.
 */

import type { Logger } from '@kbn/core/server';

import {
  DOCTYPE,
  SCHEDULED_JOB_ID_PREFIX,
  STATUS_INDEX,
} from '../../common/constants';
import type { ScheduledJobDoc } from '../../common/schemas/scheduled_job';
import {
  saveScheduledJob,
  type ScheduledJobSoClient,
} from '../repositories/scheduled_job_so_repo';

/**
 * Structural ES surface needed to read + drain the legacy docs.
 * Narrower than the existing `ScheduledJobRepoWriteEsClient` because
 * we only need search + delete here.
 */
export interface MigrationEsClient {
  search: (params: {
    index: string;
    query?: Record<string, unknown>;
    size?: number;
  }) => Promise<{
    hits: {
      hits: Array<{ _id: string; _source: Record<string, unknown> }>;
    };
  }>;
  delete: (params: {
    index: string;
    id: string;
    refresh?: 'wait_for' | 'true' | 'false' | boolean;
  }) => Promise<unknown>;
}

export interface MigrateScheduledJobsResult {
  migrated: string[];
  failed: Array<{ name: string; error: string }>;
  /** True when the legacy index didn't exist (typical for new clusters). */
  legacy_index_missing: boolean;
}

export interface MigrateScheduledJobsOptions {
  esClient: MigrationEsClient;
  soClient: ScheduledJobSoClient;
  logger: Logger;
}

/**
 * Read every legacy `scheduled_job` doc, write it as a SavedObject,
 * delete the legacy doc on success. Per-job failures land in
 * `failed[]` so a single bad doc doesn't strand the rest.
 *
 * Returns the result for callers that want to log a summary. Errors
 * during the initial search are swallowed when the index is missing
 * (new cluster — nothing to migrate); other errors throw.
 */
export async function migrateScheduledJobs(
  options: MigrateScheduledJobsOptions
): Promise<MigrateScheduledJobsResult> {
  const { esClient, soClient, logger } = options;
  const result: MigrateScheduledJobsResult = {
    migrated: [],
    failed: [],
    legacy_index_missing: false,
  };

  let response: Awaited<ReturnType<MigrationEsClient['search']>>;
  try {
    response = await esClient.search({
      index: STATUS_INDEX,
      query: { term: { doctype: DOCTYPE.scheduled_job } },
      size: 10000,
    });
  } catch (err) {
    if (isNotFound(err)) {
      // Status index never existed (fresh install) — nothing to do.
      result.legacy_index_missing = true;
      return result;
    }
    throw err;
  }

  for (const hit of response.hits.hits) {
    const src = hit._source as Partial<ScheduledJobDoc>;
    if (!src.name || typeof src.name !== 'string') {
      logger.warn(
        `Skipping legacy scheduled_job doc ${hit._id}: missing 'name' field`
      );
      result.failed.push({ name: hit._id, error: "missing 'name' field" });
      continue;
    }

    const doc: ScheduledJobDoc = {
      doctype: 'scheduled_job',
      name: src.name,
      action: src.action ?? 'rotate',
      params: src.params ?? {},
      cron: src.cron ?? null,
      interval_seconds: src.interval_seconds ?? null,
      paused: src.paused ?? false,
      created_at: src.created_at ?? new Date().toISOString(),
    };

    try {
      // overwrite:true (set inside saveScheduledJob) makes the SO
      // upsert idempotent — re-running migration after a partial
      // failure won't double-write.
      await saveScheduledJob(soClient, doc);
      // Only delete the legacy doc AFTER the SO write succeeds.
      // Crash-safe ordering: if the process dies between these calls,
      // re-running will replay the SO write (idempotent) and then
      // succeed in deleting the legacy doc.
      await esClient.delete({
        index: STATUS_INDEX,
        id: hit._id,
        refresh: 'wait_for',
      });
      result.migrated.push(doc.name);
      logger.info(`Migrated scheduled_job '${doc.name}' to SavedObject`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to migrate scheduled_job '${doc.name}': ${msg}`);
      result.failed.push({ name: doc.name, error: msg });
    }
  }

  return result;
}

/** Doc-id format used by the legacy index; exported for tests. */
export const legacyScheduledJobDocId = (name: string): string =>
  `${SCHEDULED_JOB_ID_PREFIX}${name}`;

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { statusCode?: number; meta?: { statusCode?: number } };
  return e.statusCode === 404 || e.meta?.statusCode === 404;
}
