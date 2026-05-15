import type { NavigationPublicPluginStart } from '@kbn/navigation-plugin/public';

/**
 * Plugins this plugin needs in the browser. Kept minimal in Phase 0 —
 * we add more as routes/components light up in later phases.
 */
export interface DeepfreezePluginSetupDeps {
  readonly _empty?: never;
}

export interface DeepfreezePluginStartDeps {
  navigation?: NavigationPublicPluginStart;
}

export interface DeepfreezePluginSetup {
  readonly _empty?: never;
}

export interface DeepfreezePluginStart {
  readonly _empty?: never;
}
