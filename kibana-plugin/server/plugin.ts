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
import { registerDeepfreezeTaskTypes } from './scheduler/task_types';
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

    return {};
  }

  public start(_core: CoreStart, _plugins: DeepfreezePluginStartDeps): DeepfreezePluginStart {
    this.logger.debug('deepfreeze: start');
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
