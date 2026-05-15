import type { PluginInitializerContext } from '@kbn/core/server';

import type { DeepfreezeConfig } from './config';

export { config } from './config';
export type { DeepfreezePluginSetup, DeepfreezePluginStart } from './types';

export async function plugin(initializerContext: PluginInitializerContext<DeepfreezeConfig>) {
  const { DeepfreezePlugin } = await import('./plugin');
  return new DeepfreezePlugin(initializerContext);
}
