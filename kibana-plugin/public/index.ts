import type { PluginInitializerContext } from '@kbn/core/public';

export type { DeepfreezePluginSetup, DeepfreezePluginStart } from './types';

export async function plugin(initializerContext: PluginInitializerContext) {
  const { DeepfreezePlugin } = await import('./plugin');
  return new DeepfreezePlugin(initializerContext);
}
