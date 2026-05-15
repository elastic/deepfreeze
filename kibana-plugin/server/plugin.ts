import type {
  CoreSetup,
  CoreStart,
  Logger,
  Plugin,
  PluginInitializerContext,
} from '@kbn/core/server';

import type { DeepfreezeConfig } from './config';
import type {
  DeepfreezePluginSetup,
  DeepfreezePluginSetupDeps,
  DeepfreezePluginStart,
  DeepfreezePluginStartDeps,
} from './types';

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

  constructor(initializerContext: PluginInitializerContext<DeepfreezeConfig>) {
    this.logger = initializerContext.logger.get();
    this.config = initializerContext.config.get();
  }

  public setup(
    _core: CoreSetup<DeepfreezePluginStartDeps>,
    _plugins: DeepfreezePluginSetupDeps
  ): DeepfreezePluginSetup {
    this.logger.debug('deepfreeze: setup');

    if (!this.config.enabled) {
      this.logger.info('deepfreeze plugin disabled by config');
      return {};
    }

    // Phase 1 work hooks in here:
    //   - register routes  (Task: read-only routes for /status, /repositories, /thaw-requests)
    //   - register feature privileges (deepfreeze.read / .operate / .admin)
    //   - register saved-object types (deepfreeze-config singleton)
    //   - register TaskManager task definitions (thaw-restore-poller, etc.)
    //   - register usage collector if plugins.usageCollection && config.telemetry.enabled

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
