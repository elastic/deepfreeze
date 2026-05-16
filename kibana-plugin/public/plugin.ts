import { i18n } from '@kbn/i18n';
import type {
  CoreSetup,
  CoreStart,
  Plugin,
  PluginInitializerContext,
} from '@kbn/core/public';

import type {
  DeepfreezePluginSetup,
  DeepfreezePluginSetupDeps,
  DeepfreezePluginStart,
  DeepfreezePluginStartDeps,
} from './types';

export const PLUGIN_ID = 'deepfreeze';

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
    plugins: DeepfreezePluginSetupDeps
  ): DeepfreezePluginSetup {
    plugins.management.sections.section.data.registerApp({
      id: PLUGIN_ID,
      title: i18n.translate('xpack.deepfreeze.appTitle', {
        defaultMessage: 'Deepfreeze',
      }),
      order: 9, // after Snapshot and Restore (3); tune later
      mount: async (params) => {
        const [coreStart, startPlugins] = await core.getStartServices();
        const { renderApp } = await import('./application');
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
