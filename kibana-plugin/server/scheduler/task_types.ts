/**
 * TaskManager task type definitions for deepfreeze's three schedulable
 * actions: Rotate, Cleanup, RepairMetadata.
 *
 * Mirrors the action map in the Python scheduler at
 *   packages/deepfreeze-server/deepfreeze_server/orchestration/scheduler.py
 *     — _execute_scheduled_action()
 *
 * Each task type is registered at plugin setup. Tasks are *scheduled*
 * later in Phase 5 Step 2 (via `taskManager.ensureScheduled` from the
 * scheduled-job CRUD routes). Step 1 only declares what each task type
 * does when it fires.
 *
 * Task runner contract:
 *   - `taskInstance.params` carries the action-specific config the
 *     scheduled-job doc was created with (`{keep?}` for rotate, `{}`
 *     for the others).
 *   - Each run gets a fresh internal-user ES client via
 *     `core.getStartServices()` — internal user, not asCurrentUser,
 *     because there is no incoming HTTP request.
 *   - Audit rows record `user: 'scheduler'` so the Activity tab can
 *     distinguish scheduled runs from user-initiated ones.
 *   - The function returns next-run state; we keep state minimal
 *     (last_success / last_error) so the audit + scheduled_job doc
 *     remain the source of truth for run history.
 */

import type { CoreStart, Logger } from '@kbn/core/server';
import type {
  RunContext,
  TaskManagerSetupContract,
} from '@kbn/task-manager-plugin/server';

import { AuditLogger } from '../audit';
import type { AuditEsClient } from '../audit/types';
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
  type UpdateDateRangesConfig,
} from '../actions/update_date_ranges';
import { getSettings } from '../repositories/settings_repo';
import {
  storageClientFactory,
  type AwsStorageClientOptions,
} from '../storage/factory';

/** Canonical task-type identifiers used both at register and schedule time. */
export const TASK_TYPES = {
  rotate: 'deepfreeze:rotate',
  cleanup: 'deepfreeze:cleanup',
  repairMetadata: 'deepfreeze:repair-metadata',
  updateDateRanges: 'deepfreeze:update-date-ranges',
} as const;

export type DeepfreezeTaskType = (typeof TASK_TYPES)[keyof typeof TASK_TYPES];

/** Shape passed to each task runner so it can grab fresh clients on run. */
export interface RegisterDeepfreezeTaskTypesOptions {
  taskManager: TaskManagerSetupContract;
  logger: Logger;
  /** Plugin version string, included on every audit row. */
  version: string;
  /**
   * Resolves to the CoreStart contract once the plugin is started.
   * Captured at setup time via `core.getStartServices()` — the task
   * runner can't reach for it directly because it has no HTTP context.
   */
  getStartServices: () => Promise<[CoreStart, ...unknown[]]>;
  /** Optional AWS-specific knobs threaded through to the StorageClient factory. */
  storageOptions?: { aws?: AwsStorageClientOptions };
}

/**
 * State shape persisted by TaskManager between runs. Kept narrow: just
 * the last completion outcome so an operator can correlate the audit
 * row to the task's bookkeeping.
 *
 * Declared as an intersection with `Record<string, unknown>` so it
 * satisfies TaskManager's structural state contract while still
 * documenting the fields we actually populate.
 */
type DeepfreezeTaskState = Record<string, unknown> & {
  last_run_at?: string;
  last_success?: boolean;
  last_error?: string;
};

/**
 * Capture errors from a single task run and return them as state for
 * the next iteration. Mirrors the Python scheduler's "log and continue"
 * pattern — exceptions from the action layer don't kill the task type.
 */
async function runWrapper<T>(
  taskType: DeepfreezeTaskType,
  logger: Logger,
  fn: () => Promise<T>
): Promise<{ state: DeepfreezeTaskState }> {
  const startedAt = new Date().toISOString();
  try {
    await fn();
    return {
      state: { last_run_at: startedAt, last_success: true },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[${taskType}] scheduled run failed: ${msg}`);
    return {
      state: { last_run_at: startedAt, last_success: false, last_error: msg },
    };
  }
}

export function registerDeepfreezeTaskTypes(
  opts: RegisterDeepfreezeTaskTypesOptions
): void {
  const { taskManager, logger, version, getStartServices, storageOptions } = opts;

  const log = {
    debug: (m: string) => logger.debug(m),
    warn: (m: string) => logger.warn(m),
  };

  async function getInternalEsClient(): Promise<
    RotateActionEsClient &
      CleanupActionEsClient &
      RepairMetadataActionEsClient &
      UpdateDateRangesActionEsClient &
      AuditEsClient
  > {
    const [coreStart] = await getStartServices();
    // The plugin's actions accept a structural subset of the real ES
    // client; the cast at this boundary mirrors how route handlers
    // wire client.asCurrentUser into the action surface.
    return coreStart.elasticsearch.client.asInternalUser as unknown as RotateActionEsClient &
      CleanupActionEsClient &
      RepairMetadataActionEsClient &
      UpdateDateRangesActionEsClient &
      AuditEsClient;
  }

  function makeAudit(client: AuditEsClient): AuditLogger {
    return new AuditLogger(client, {
      enabled: true,
      version,
      hostname: 'kibana',
      log,
    });
  }

  taskManager.registerTaskDefinitions({
    [TASK_TYPES.rotate]: {
      title: 'Deepfreeze: rotate snapshot repository',
      description:
        'Create the next-suffix repository, version the ILM policy, capture date ranges, and unmount repos beyond the keep window.',
      maxAttempts: 1,
      createTaskRunner: ({ taskInstance }: RunContext) => ({
        async run() {
          return runWrapper(TASK_TYPES.rotate, logger, async () => {
            const client = await getInternalEsClient();
            const params = (taskInstance.params ?? {}) as RotateConfig;
            const audit = makeAudit(client);
            await audit.track(
              {
                action: 'rotate',
                dryRun: false,
                parameters: { ...params, triggered_by: 'schedule' },
                user: 'scheduler',
              },
              async (tracker) => {
                const out = await runRotate(client, params, { log });
                for (const step of out.steps) {
                  tracker.addResult({
                    type: step.type,
                    action: step.action,
                    ...(step.name ? { target: step.name } : {}),
                    ...(step.detail ? { detail: step.detail } : {}),
                  });
                }
                tracker.setSummary({
                  new_repo: out.new_repo_name,
                  archived_count: out.archived.length,
                  skipped_count: out.skipped.length,
                });
                for (const e of out.errors) {
                  tracker.addError({ code: e.code, message: e.message });
                }
                return out;
              }
            );
          });
        },
      }),
    },

    [TASK_TYPES.cleanup]: {
      title: 'Deepfreeze: cleanup stale thaw requests and expired repos',
      description:
        'Drop thaw-request docs beyond their retention windows and flip expired repositories to the expired state.',
      maxAttempts: 1,
      createTaskRunner: ({ taskInstance }: RunContext) => ({
        async run() {
          return runWrapper(TASK_TYPES.cleanup, logger, async () => {
            const client = await getInternalEsClient();
            const params = (taskInstance.params ?? {}) as Record<string, unknown>;
            const audit = makeAudit(client);
            await audit.track(
              {
                action: 'cleanup',
                dryRun: false,
                parameters: { ...params, triggered_by: 'schedule' },
                user: 'scheduler',
              },
              async (tracker) => {
                const out = await runCleanup(client, {}, { log });
                for (const step of out.steps) {
                  tracker.addResult({
                    type: step.type,
                    action: step.action,
                    ...(step.name ? { target: step.name } : {}),
                    ...(step.detail ? { detail: step.detail } : {}),
                  });
                }
                tracker.setSummary({
                  deleted_thaw_requests: out.deleted_thaw_requests.length,
                  expired_repositories: out.expired_repositories.length,
                });
                for (const e of out.errors) {
                  tracker.addError({ code: e.code, message: e.message });
                }
                return out;
              }
            );
          });
        },
      }),
    },

    [TASK_TYPES.repairMetadata]: {
      title: 'Deepfreeze: repair repository metadata',
      description:
        'Reconcile recorded thaw_state with actual S3 storage state, and populate missing repository date ranges.',
      maxAttempts: 1,
      createTaskRunner: ({ taskInstance }: RunContext) => ({
        async run() {
          return runWrapper(TASK_TYPES.repairMetadata, logger, async () => {
            const client = await getInternalEsClient();
            const params = (taskInstance.params ?? {}) as Record<string, unknown>;
            // RepairMetadata needs a StorageClient to inspect S3.
            // Settings determine the provider; bail with a clear log
            // line if uninitialized so the task doesn't repeatedly
            // throw against a stripped cluster.
            const settings = await getSettings(client);
            if (!settings) {
              logger.debug(
                '[deepfreeze:repair-metadata] settings doc absent; skipping run'
              );
              return;
            }
            const storage = await storageClientFactory(
              settings.provider,
              storageOptions?.aws ?? {}
            );
            const audit = makeAudit(client);
            await audit.track(
              {
                action: 'repair_metadata',
                dryRun: false,
                parameters: { ...params, triggered_by: 'schedule' },
                user: 'scheduler',
              },
              async (tracker) => {
                const out = await runRepairMetadata(client, storage, { log });
                for (const r of out.repaired) {
                  tracker.addResult({
                    type: 'repository',
                    action: 'repaired',
                    target: r.repo,
                    detail: `${r.from} → ${r.to}`,
                  });
                }
                for (const f of out.failed) {
                  tracker.addResult({
                    type: 'repository',
                    action: 'failed',
                    target: f.repo,
                    detail: f.error ?? '',
                  });
                }
                for (const d of out.date_ranges) {
                  if (!d.changed) continue;
                  tracker.addResult({
                    type: 'repository',
                    action: 'date_range_set',
                    target: d.repo,
                    detail: `${d.start ?? '?'} → ${d.end ?? '?'}`,
                  });
                }
                tracker.setSummary({
                  discrepancies: out.discrepancies.length,
                  repaired_count: out.repaired.length,
                  failed_count: out.failed.length,
                  date_ranges_changed: out.date_ranges.filter((d) => d.changed)
                    .length,
                });
                for (const e of out.errors) {
                  tracker.addError({ code: e.code, message: e.message });
                }
                return out;
              }
            );
          });
        },
      }),
    },

    [TASK_TYPES.updateDateRanges]: {
      title: 'Deepfreeze: update repository date ranges',
      description:
        'Walk every mounted repository and extend its persisted start/end based on the current @timestamp range of its indices.',
      maxAttempts: 1,
      createTaskRunner: ({ taskInstance }: RunContext) => ({
        async run() {
          return runWrapper(TASK_TYPES.updateDateRanges, logger, async () => {
            const client = await getInternalEsClient();
            const params = (taskInstance.params ?? {}) as UpdateDateRangesConfig;
            const audit = makeAudit(client);
            await audit.track(
              {
                action: 'update_date_ranges',
                dryRun: false,
                parameters: { ...params, triggered_by: 'schedule' },
                user: 'scheduler',
              },
              async (tracker) => {
                const out = await runUpdateDateRanges(client, params, { log });
                for (const step of out.steps) {
                  tracker.addResult({
                    type: step.type,
                    action: step.action,
                    target: step.name,
                    ...(step.detail ? { detail: step.detail } : {}),
                  });
                }
                tracker.setSummary({
                  updated_count: out.updated.length,
                  unchanged_count: out.unchanged.length,
                  skipped_count: out.skipped.length,
                });
                for (const e of out.errors) {
                  tracker.addError({ code: e.code, message: e.message });
                }
                return out;
              }
            );
          });
        },
      }),
    },
  });
}
