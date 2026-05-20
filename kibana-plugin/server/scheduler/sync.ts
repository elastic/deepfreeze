/**
 * Helpers shared between the schedules CRUD route and its unit tests.
 *
 * Kept in this separate file so the tests don't transitively import
 * `@kbn/config-schema` (the route's runtime-only dep), letting them
 * run in the plugin's standalone Jest env without a Kibana checkout.
 */

import type { TaskManagerStartContract } from '@kbn/task-manager-plugin/server';

import type { ScheduledJobDoc } from '../../common/schemas/scheduled_job';
import {
  runRotate,
  type RotateActionEsClient,
  type RotateConfig,
} from '../actions/rotate';
import { runCleanup, type CleanupActionEsClient } from '../actions/cleanup';
import {
  runRepairMetadata,
  type RepairMetadataActionEsClient,
} from '../actions/repair_metadata';
import {
  runUpdateDateRanges,
  type UpdateDateRangesActionEsClient,
} from '../actions/update_date_ranges';
import { ActionError } from '../errors';
import { getSettings } from '../repositories/settings_repo';
import {
  storageClientFactory,
  type AwsStorageClientOptions,
} from '../storage/factory';
import { bootstrapTaskId, resolveTaskTypeForAction } from './bootstrap';

/**
 * Push the desired state of a scheduled_job doc into TaskManager. Used
 * by every mutating CRUD route after the ES write succeeds.
 *
 * Returns the actual sync action taken so the caller can log it.
 *
 * Implementation note: TaskManager's `ensureScheduled` is "create if
 * missing" semantics — it does NOT update an existing task's
 * interval. If we relied on it for both create and update, editing a
 * job's interval would silently leave TaskManager firing at the
 * original cadence. To keep the schedule in sync with the doc, we
 * remove any existing task first and then schedule fresh. The brief
 * gap (sub-millisecond) is acceptable because in-flight runs are
 * allowed to complete by TaskManager; a missed fire window is no
 * different from any other normal scheduling jitter.
 */
export async function syncTaskManager(
  taskManager: TaskManagerStartContract,
  job: ScheduledJobDoc
): Promise<'scheduled' | 'paused_removed' | 'invalid_action_removed'> {
  const id = bootstrapTaskId(job.name);
  const taskType = resolveTaskTypeForAction(job.action);
  if (taskType === null) {
    await taskManager.removeIfExists(id);
    return 'invalid_action_removed';
  }
  if (job.paused) {
    await taskManager.removeIfExists(id);
    return 'paused_removed';
  }
  if (!job.interval_seconds || job.interval_seconds <= 0) {
    await taskManager.removeIfExists(id);
    return 'invalid_action_removed';
  }
  // Force a fresh schedule so interval/param updates actually take effect.
  await taskManager.removeIfExists(id);
  await taskManager.ensureScheduled({
    id,
    taskType,
    schedule: { interval: `${job.interval_seconds}s` },
    params: job.params ?? {},
    state: {},
    scope: ['deepfreeze'],
  });
  return 'scheduled';
}

/**
 * Synchronously invoke the action a scheduled job would run. Used by
 * the run-now route. Mirrors the same audit + storage wiring the task
 * runner does, but inline so the operator gets the result back in the
 * HTTP response.
 */
export async function runActionForSchedule(
  client: RotateActionEsClient &
    CleanupActionEsClient &
    RepairMetadataActionEsClient &
    UpdateDateRangesActionEsClient,
  job: ScheduledJobDoc,
  opts: {
    log: { debug: (m: string) => void; warn: (m: string) => void };
    storageOptions?: { aws?: AwsStorageClientOptions };
  }
): Promise<unknown> {
  if (job.action === 'rotate') {
    return runRotate(client, (job.params ?? {}) as RotateConfig, { log: opts.log });
  }
  if (job.action === 'cleanup') {
    return runCleanup(client, {}, { log: opts.log });
  }
  if (job.action === 'repair_metadata' || job.action === 'repair') {
    const settings = await getSettings(client);
    if (!settings) {
      throw new ActionError('Settings document not found in status index');
    }
    const storage = await storageClientFactory(
      settings.provider,
      opts.storageOptions?.aws ?? {}
    );
    return runRepairMetadata(client, storage, { log: opts.log });
  }
  if (job.action === 'update_date_ranges') {
    return runUpdateDateRanges(client, job.params ?? {}, { log: opts.log });
  }
  throw new ActionError(`Unsupported schedule action '${job.action}'`);
}
