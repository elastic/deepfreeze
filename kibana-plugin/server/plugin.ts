import type {
  CoreSetup,
  CoreStart,
  KibanaRequest,
  Logger,
  Plugin,
  PluginInitializerContext,
} from '@kbn/core/server';

import type { DeepfreezeConfig } from './config';
import {
  registerAuditRoute,
  registerCleanupRoute,
  registerRefreezeRoute,
  registerRepairMetadataRoute,
  registerRotateRoute,
  registerSetupRoute,
  registerStatusRoute,
  registerThawRoute,
} from './routes';
import { bootstrapDeepfreezeSchedules } from './scheduler/bootstrap';
import {
  createSchedulerDiagnosticsState,
  registerSchedulerDiagnosticsRoute,
  type SchedulerDiagnosticsState,
} from './scheduler/diagnostics_route';
import { migrateScheduledJobs } from './scheduler/migration';
import { registerSchedulesRoute } from './scheduler/schedules_route';
import { registerDeepfreezeTaskTypes } from './scheduler/task_types';
import { registerScheduledJobSavedObject } from './saved_objects/scheduled_job_type';
import type { TaskManagerStartContract } from '@kbn/task-manager-plugin/server';
import { registerDeepfreezeUsageCollector } from './telemetry';
import type {
  DeepfreezePluginSetup,
  DeepfreezePluginSetupDeps,
  DeepfreezePluginStart,
  DeepfreezePluginStartDeps,
} from './types';

const PLUGIN_ID = 'deepfreeze';

/**
 * Cluster privileges the requestor must hold for any deepfreeze API
 * call. Phase 1 only needs read access; mutating actions will add
 * write privileges (e.g. `manage`, `manage_slm`) in later phases.
 */
const REQUIRED_CLUSTER_PRIVILEGES = ['monitor'];

export class DeepfreezePlugin
  implements
    Plugin<
      DeepfreezePluginSetup,
      DeepfreezePluginStart,
      DeepfreezePluginSetupDeps,
      DeepfreezePluginStartDeps
    >
{
  private readonly logger: Logger;
  private readonly config: DeepfreezeConfig;
  private readonly version: string;
  /**
   * Mutable holder for the scheduler-bootstrap result. Captured by
   * plugin.start() and read by the diagnostics route registered in
   * plugin.setup(). Shared by reference so the route doesn't need a
   * separate getter wiring.
   */
  private readonly schedulerDiagnostics: SchedulerDiagnosticsState =
    createSchedulerDiagnosticsState();
  /**
   * Captured at plugin.start so the schedules CRUD routes (registered
   * at setup time) can resolve it lazily via the getter below.
   */
  private taskManagerStart: TaskManagerStartContract | null = null;

  constructor(initializerContext: PluginInitializerContext<DeepfreezeConfig>) {
    this.logger = initializerContext.logger.get();
    this.config = initializerContext.config.get();
    this.version = initializerContext.env.packageInfo.version;
  }

  public setup(
    core: CoreSetup<DeepfreezePluginStartDeps>,
    plugins: DeepfreezePluginSetupDeps
  ): DeepfreezePluginSetup {
    this.logger.debug('deepfreeze: setup');

    if (!this.config.enabled) {
      this.logger.info('deepfreeze plugin disabled by config');
      return {};
    }

    // Register the SavedObject type for scheduled jobs. Must happen
    // during setup so the type is known by the time plugin.start tries
    // to create / read SOs from it.
    registerScheduledJobSavedObject(core);

    plugins.features.registerElasticsearchFeature({
      id: PLUGIN_ID,
      management: {
        data: [PLUGIN_ID],
      },
      catalogue: [PLUGIN_ID],
      privileges: [
        {
          requiredClusterPrivileges: REQUIRED_CLUSTER_PRIVILEGES,
          ui: [],
        },
      ],
    });

    const router = core.http.createRouter();
    registerStatusRoute(router, this.logger);
    registerAuditRoute(router, this.logger, this.version);
    const getCurrentUser = this.makeGetCurrentUser(core);
    registerSetupRoute({
      router,
      logger: this.logger,
      version: this.version,
      getCurrentUser,
    });
    registerRotateRoute({
      router,
      logger: this.logger,
      version: this.version,
      getCurrentUser,
    });
    registerCleanupRoute({
      router,
      logger: this.logger,
      version: this.version,
      getCurrentUser,
    });
    registerRefreezeRoute({
      router,
      logger: this.logger,
      version: this.version,
      getCurrentUser,
    });
    registerThawRoute({
      router,
      logger: this.logger,
      version: this.version,
      getCurrentUser,
    });
    registerRepairMetadataRoute({
      router,
      logger: this.logger,
      version: this.version,
      getCurrentUser,
    });

    if (this.config.telemetry.enabled && plugins.usageCollection) {
      this.logger.debug('deepfreeze: registering usage collector');
      registerDeepfreezeUsageCollector({ usageCollection: plugins.usageCollection });
    }

    // Register the three schedulable task types. No tasks are scheduled
    // yet — Phase 5 Step 2 will read scheduled_job docs and call
    // taskManager.ensureScheduled at plugin start.
    registerDeepfreezeTaskTypes({
      taskManager: plugins.taskManager,
      logger: this.logger,
      version: this.version,
      getStartServices: () => core.getStartServices(),
    });

    // Operator-visible diagnostics: shows what the bootstrap did,
    // plus side-by-side counts of `scheduled_job` docs visible to
    // the current-user vs the internal-user (so permissions issues
    // surface clearly).
    registerSchedulerDiagnosticsRoute({
      router,
      logger: this.logger,
      state: this.schedulerDiagnostics,
    });

    // CRUD for scheduled jobs. The route is registered during setup
    // but needs the TaskManager start contract; we resolve it lazily
    // via the getter (populated in plugin.start below).
    registerSchedulesRoute({
      router,
      logger: this.logger,
      version: this.version,
      getCurrentUser,
      getTaskManager: () => {
        if (!this.taskManagerStart) {
          throw new Error(
            'TaskManager start contract not available yet — plugin is still starting'
          );
        }
        return this.taskManagerStart;
      },
    });

    return {};
  }

  public start(core: CoreStart, plugins: DeepfreezePluginStartDeps): DeepfreezePluginStart {
    this.logger.debug('deepfreeze: start');

    // Stash the TaskManager start contract so the CRUD routes can use
    // it. Must happen before bootstrap runs so route handlers that
    // fire during bootstrap won't see a null reference.
    this.taskManagerStart = plugins.taskManager;

    if (this.config.enabled) {
      // Fire-and-forget: migrate any legacy scheduled_job docs out of
      // deepfreeze-status into SavedObjects, then materialize SOs into
      // TaskManager. Slow ES reads can't block plugin start; errors
      // are logged and surfaced via the diagnostics endpoint.
      const esInternalClient =
        core.elasticsearch.client.asInternalUser as unknown as Parameters<
          typeof migrateScheduledJobs
        >[0]['esClient'];
      // The internal SavedObjects repository bypasses user privileges
      // and reads .kibana_* directly — exactly what we need for both
      // the migration and the bootstrap.
      const soRepo = core.savedObjects.createInternalRepository();

      (async () => {
        try {
          const migration = await migrateScheduledJobs({
            esClient: esInternalClient,
            soClient: soRepo as unknown as Parameters<
              typeof migrateScheduledJobs
            >[0]['soClient'],
            logger: this.logger,
          });
          if (migration.migrated.length > 0 || migration.failed.length > 0) {
            this.logger.info(
              `deepfreeze: scheduled_job migration — ` +
                `${migration.migrated.length} migrated, ` +
                `${migration.failed.length} failed`
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(`deepfreeze: scheduled_job migration failed: ${msg}`);
        }

        try {
          const result = await bootstrapDeepfreezeSchedules({
            client: soRepo as unknown as Parameters<
              typeof bootstrapDeepfreezeSchedules
            >[0]['client'],
            taskManager: plugins.taskManager,
            logger: this.logger,
          });
          this.schedulerDiagnostics.last_bootstrap_at = new Date().toISOString();
          this.schedulerDiagnostics.last_result = result;
          this.schedulerDiagnostics.last_error = null;
          this.logger.info(
            `deepfreeze: bootstrap complete — ` +
              `${result.scheduled.length} scheduled, ` +
              `${result.paused.length} paused, ` +
              `${result.skipped.length} skipped, ` +
              `${result.errors.length} error(s)`
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.schedulerDiagnostics.last_bootstrap_at = new Date().toISOString();
          this.schedulerDiagnostics.last_result = null;
          this.schedulerDiagnostics.last_error = msg;
          this.logger.error(`deepfreeze: bootstrap failed: ${msg}`);
        }
      })();
    }

    return {};
  }

  public stop() {
    this.logger.debug('deepfreeze: stop');
  }

  /**
   * Build the request → username resolver passed to Setup routes.
   * Returns 'kibana' when the optional security plugin is absent so
   * audit rows are still attributable.
   */
  private makeGetCurrentUser(core: CoreSetup<DeepfreezePluginStartDeps>) {
    return async (request: KibanaRequest): Promise<string> => {
      const [, pluginsStart] = await core.getStartServices();
      const user = pluginsStart.security?.authc.getCurrentUser(request);
      return user?.username ?? 'kibana';
    };
  }
}
