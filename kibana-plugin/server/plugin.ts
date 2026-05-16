import type {
  CoreSetup,
  CoreStart,
  Logger,
  Plugin,
  PluginInitializerContext,
} from '@kbn/core/server';

import type { DeepfreezeConfig } from './config';
import { registerAuditRoute, registerStatusRoute } from './routes';
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

    return {};
  }

  public start(_core: CoreStart, _plugins: DeepfreezePluginStartDeps): DeepfreezePluginStart {
    this.logger.debug('deepfreeze: start');
    return {};
  }

  public stop() {
    this.logger.debug('deepfreeze: stop');
  }
}
