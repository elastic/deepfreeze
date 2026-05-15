import type {
  AppMountParameters,
  CoreSetup,
  CoreStart,
  Plugin,
  PluginInitializerContext,
} from '@kbn/core/public';
import { DEFAULT_APP_CATEGORIES } from '@kbn/core/public';

import type {
  DeepfreezePluginSetup,
  DeepfreezePluginSetupDeps,
  DeepfreezePluginStart,
  DeepfreezePluginStartDeps,
} from './types';

export const PLUGIN_ID = 'deepfreeze';
export const PLUGIN_NAME = 'Deepfreeze';

export class DeepfreezePlugin
  implements
    Plugin<
      DeepfreezePluginSetup,
      DeepfreezePluginStart,
      DeepfreezePluginSetupDeps,
      DeepfreezePluginStartDeps
    >
{
  constructor(_initializerContext: PluginInitializerContext) {}

  public setup(
    core: CoreSetup<DeepfreezePluginStartDeps, DeepfreezePluginStart>,
    _plugins: DeepfreezePluginSetupDeps
  ): DeepfreezePluginSetup {
    core.application.register({
      id: PLUGIN_ID,
      title: PLUGIN_NAME,
      category: DEFAULT_APP_CATEGORIES.management,
      order: 8500,
      async mount(params: AppMountParameters) {
        const { renderApp } = await import('./application');
        const [coreStart, startPlugins] = await core.getStartServices();
        return renderApp(coreStart, startPlugins, params);
      },
    });

    return {};
  }

  public start(_core: CoreStart, _plugins: DeepfreezePluginStartDeps): DeepfreezePluginStart {
    return {};
  }

  public stop() {}
}
