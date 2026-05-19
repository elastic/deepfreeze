/**
 * Plugin-start bootstrap that materializes deepfreeze scheduled-job
 * SavedObjects into live Kibana TaskManager tasks.
 *
 * On every plugin start (after the legacy-doc migration), we:
 *   1. Read every `deepfreeze-scheduled-job` SavedObject.
 *   2. For each non-paused job → `taskManager.ensureScheduled` so
 *      TaskManager creates / refreshes the task instance.
 *   3. For each paused job → `taskManager.removeIfExists` so it's
 *      absent from TaskManager while still persisted as a SO.
 *   4. Sweep TaskManager for any deepfreeze task whose SO no longer
 *      exists (an "orphan") and remove it. This is the only way an
 *      operator can clean up a stale task: ES restricts writes to
 *      `.kibana_task_manager` to the `kibana_system` privilege, so
 *      even a superuser can't `DELETE` the doc directly — the cleanup
 *      has to happen through TaskManager's own API, which we own.
 *
 * Errors per-job are caught and logged so a single malformed SO can't
 * prevent the plugin from starting. The bootstrap is idempotent and
 * safe to call again after CRUD-route edits.
 *
 * Mirrors `DeepfreezeScheduler._load_persisted_jobs` in
 *   packages/deepfreeze-server/deepfreeze_server/orchestration/scheduler.py
 *
 * Two intentional design choices:
 *   - **Cron expressions are not supported.** TaskManager natively
 *     handles `schedule.interval` ('3600s'-style), which covers
 *     "every N minutes/hours/days." Cron-style "every day at 02:00"
 *     scheduling would require a parser + recompute-next-runAt-on-
 *     completion plumbing and offers no operational benefit for the
 *     three deepfreeze action types (rotate / cleanup / repair-metadata),
 *     where frequency matters more than wall-clock time. cron-only
 *     docs are skipped with a clear warning so the operator can
 *     convert them to interval-based without surprise.
 *   - Unknown `action` values are skipped with a warning rather than
 *     bringing down the plugin.
 */

import type { Logger } from '@kbn/core/server';
import type { TaskManagerStartContract } from '@kbn/task-manager-plugin/server';

import { SCHEDULED_JOB_ID_PREFIX } from '../../common/constants';
import type { ScheduledJobDoc } from '../../common/schemas/scheduled_job';
import {
  getAllScheduledJobs,
  type ScheduledJobSoClient,
} from '../repositories/scheduled_job_so_repo';
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
  // Use the legacy `scheduled_job:` prefix so the TaskManager ids
  // produced by this bootstrap stay byte-stable across the ES →
  // SavedObjects migration. Clusters that had tasks running under
  // these ids before the migration continue to find them after.
  return `${SCHEDULED_JOB_ID_PREFIX}${jobName}`;
}

export interface BootstrapDeepfreezeSchedulesOptions {
  client: ScheduledJobSoClient;
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
  /**
   * TaskManager task ids that existed at start but had no
   * corresponding SO (e.g. left over from a deleted job under an
   * older code path, or from a since-removed legacy doc). The sweep
   * removed them.
   */
  removed_orphans: string[];
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
    removed_orphans: [],
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

  await sweepOrphanTasks(jobs, taskManager, logger, result);

  return result;
}

/**
 * Find any TaskManager task whose taskType is one of ours but whose
 * id doesn't map to a known SO, and remove it. Failures here are
 * non-fatal — we log and let plugin start continue.
 */
async function sweepOrphanTasks(
  jobs: ScheduledJobDoc[],
  taskManager: TaskManagerStartContract,
  logger: Logger,
  result: BootstrapDeepfreezeSchedulesResult
): Promise<void> {
  const knownIds = new Set(jobs.map((j) => bootstrapTaskId(j.name)));
  const deepfreezeTaskTypes = Object.values(TASK_TYPES);

  let docs: Array<{ id: string; taskType: string }>;
  try {
    const fetched = await taskManager.fetch({
      query: { terms: { 'task.taskType': deepfreezeTaskTypes } },
      size: 1000,
    });
    docs = fetched.docs.map((d) => ({ id: d.id, taskType: d.taskType }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`deepfreeze: orphan task sweep failed to enumerate tasks: ${msg}`);
    return;
  }

  for (const doc of docs) {
    if (knownIds.has(doc.id)) continue;
    try {
      await taskManager.removeIfExists(doc.id);
      logger.info(
        `deepfreeze: removed orphan task ${doc.id} (${doc.taskType}) — no matching scheduled-job SO`
      );
      result.removed_orphans.push(doc.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`deepfreeze: failed to remove orphan task ${doc.id}: ${msg}`);
      result.errors.push({ name: doc.id, error: msg });
    }
  }
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

  // Cron expressions are not supported — see the module-level doc
  // comment. The schema retains the `cron` field for Python parity
  // (Python's APScheduler-backed scheduler does support cron) but
  // the Kibana plugin scheduler is interval-only.
  if (job.cron && !job.interval_seconds) {
    logger.warn(
      `Scheduled job ${job.name} uses cron='${job.cron}' which is not supported; skipping`
    );
    result.skipped.push({
      name: job.name,
      reason: 'cron expressions not supported; use interval_seconds instead',
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
