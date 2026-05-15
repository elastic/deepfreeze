import type { PluginInitializerContext } from '@kbn/core/public';

import { DeepfreezePlugin } from './plugin';

export type { DeepfreezePluginSetup, DeepfreezePluginStart } from './types';

export const plugin = (initializerContext: PluginInitializerContext) =>
  new DeepfreezePlugin(initializerContext);
