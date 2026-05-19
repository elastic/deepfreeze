/**
 * Plugin-start bootstrap that materializes deepfreeze scheduled-job
 * docs into live Kibana TaskManager tasks.
 *
 * On every plugin start, we:
 *   1. Read every `scheduled_job:*` doc from the status index.
 *   2. For each non-paused job → `taskManager.ensureScheduled` so
 *      TaskManager creates / refreshes the task instance.
 *   3. For each paused job → `taskManager.removeIfExists` so it's
 *      absent from TaskManager while still persisted in our index.
 *
 * Errors per-job are caught and logged so a single malformed doc can't
 * prevent the plugin from starting. The bootstrap is idempotent and
 * safe to call again after edits land via Step 3's CRUD routes.
 *
 * Mirrors `DeepfreezeScheduler._load_persisted_jobs` in
 *   packages/deepfreeze-server/deepfreeze_server/orchestration/scheduler.py
 *
 * Step 2 limitations (carried over from Phase 5 plan):
 *   - cron-only docs are skipped with a warning. TaskManager's
 *     `schedule.interval` covers the common case; cron support requires
 *     a parser + recompute-next-runAt-on-completion, deferred to a
 *     Phase 5b follow-up.
 *   - Unknown `action` values are skipped with a warning rather than
 *     bringing down the plugin.
 */

import type { Logger } from '@kbn/core/server';
import type { TaskManagerStartContract } from '@kbn/task-manager-plugin/server';

import type { ScheduledJobDoc } from '../../common/schemas/scheduled_job';
import {
  getAllScheduledJobs,
  scheduledJobDocId,
  type ScheduledJobRepoEsClient,
} from '../repositories/scheduled_job_repo';
import { TASK_TYPES, type DeepfreezeTaskType } from './task_types';

/**
 * Map a `ScheduledJobDoc.action` string to the registered TaskManager
 * task type. Returns `null` for unknown actions; the caller logs and
 * skips. The mapping mirrors Python's
 *   scheduler.py:_execute_scheduled_action — action_map dict
 * minus the actions we haven't ported (thaw_check, refreeze).
 */
export function resolveTaskTypeForAction(action: string): DeepfreezeTaskType | null {
  switch (action) {
    case 'rotate':
      return TASK_TYPES.rotate;
    case 'cleanup':
      return TASK_TYPES.cleanup;
    // Accept both spellings — Python uses 'repair'; the curator CLI
    // and a few tests use 'repair_metadata'. Both map to the same
    // task type.
    case 'repair':
    case 'repair_metadata':
      return TASK_TYPES.repairMetadata;
    default:
      return null;
  }
}

/**
 * Build the TaskManager task ID for a scheduled job. We deliberately
 * use a deepfreeze-specific prefix so:
 *   - We can enumerate "our" tasks distinctly from Kibana's built-ins
 *   - removeIfExists during the paused-job sweep doesn't accidentally
 *     touch unrelated tasks even if names collide
 */
export function bootstrapTaskId(jobName: string): string {
  // Use the same doc-id prefix so the TaskManager id and our ES doc id
  // are easy to correlate during debugging.
  return scheduledJobDocId(jobName);
}

export interface BootstrapDeepfreezeSchedulesOptions {
  client: ScheduledJobRepoEsClient;
  taskManager: TaskManagerStartContract;
  logger: Logger;
}

/**
 * Outcome counts for the bootstrap run. Used by tests + an eventual
 * structured log line.
 */
export interface BootstrapDeepfreezeSchedulesResult {
  scheduled: string[];
  paused: string[];
  skipped: Array<{ name: string; reason: string }>;
  errors: Array<{ name: string; error: string }>;
}

/**
 * Top-level bootstrap entry point invoked from `plugin.start`.
 *
 * Reads every scheduled-job doc, sweeps TaskManager so it reflects the
 * desired state (non-paused → ensureScheduled, paused → removeIfExists,
 * everything else → skip-with-warning).
 *
 * Never throws on a per-job problem. Throws only if the initial doc
 * fetch fails catastrophically — in that case the plugin start should
 * fail loudly because we can't reason about what's scheduled.
 */
export async function bootstrapDeepfreezeSchedules(
  options: BootstrapDeepfreezeSchedulesOptions
): Promise<BootstrapDeepfreezeSchedulesResult> {
  const { client, taskManager, logger } = options;
  const result: BootstrapDeepfreezeSchedulesResult = {
    scheduled: [],
    paused: [],
    skipped: [],
    errors: [],
  };

  const jobs = await getAllScheduledJobs(client);
  logger.debug(`deepfreeze: bootstrapping ${jobs.length} scheduled-job doc(s)`);

  for (const job of jobs) {
    try {
      await applyScheduledJob(job, taskManager, logger, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to bootstrap schedule ${job.name}: ${msg}`);
      result.errors.push({ name: job.name, error: msg });
    }
  }

  return result;
}

async function applyScheduledJob(
  job: ScheduledJobDoc,
  taskManager: TaskManagerStartContract,
  logger: Logger,
  result: BootstrapDeepfreezeSchedulesResult
): Promise<void> {
  const taskType = resolveTaskTypeForAction(job.action);
  if (taskType === null) {
    logger.warn(
      `Scheduled job ${job.name} has unknown action '${job.action}'; skipping`
    );
    result.skipped.push({
      name: job.name,
      reason: `unknown action '${job.action}'`,
    });
    return;
  }

  const id = bootstrapTaskId(job.name);

  // Paused jobs: keep the doc, drop the TaskManager instance so it
  // doesn't fire. Step 3's resume route flips paused→false and re-runs
  // this same path.
  if (job.paused) {
    await taskManager.removeIfExists(id);
    result.paused.push(job.name);
    return;
  }

  // Cron-only jobs are out of scope for Step 2 — needs a parser plus
  // recompute-next-runAt-on-completion logic. Defer to Phase 5b.
  if (job.cron && !job.interval_seconds) {
    logger.warn(
      `Scheduled job ${job.name} uses cron='${job.cron}' which is not yet supported; skipping`
    );
    result.skipped.push({
      name: job.name,
      reason: 'cron expressions not yet supported (Phase 5b)',
    });
    // Defensive: in case it was scheduled previously with a cron->interval
    // mapping that's now invalid, remove it so it doesn't keep firing.
    await taskManager.removeIfExists(id);
    return;
  }

  // Must have an interval to schedule.
  if (!job.interval_seconds || job.interval_seconds <= 0) {
    logger.warn(
      `Scheduled job ${job.name} has no valid interval_seconds; skipping`
    );
    result.skipped.push({
      name: job.name,
      reason: 'no interval_seconds set',
    });
    return;
  }

  await taskManager.ensureScheduled({
    id,
    taskType,
    schedule: { interval: `${job.interval_seconds}s` },
    params: job.params ?? {},
    state: {},
    scope: ['deepfreeze'],
  });
  result.scheduled.push(job.name);
  logger.debug(
    `deepfreeze: scheduled ${job.name} (${taskType}) every ${job.interval_seconds}s`
  );
}
