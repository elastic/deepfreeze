import type { ManagementSetup } from '@kbn/management-plugin/public';
import type { NavigationPublicPluginStart } from '@kbn/navigation-plugin/public';

export interface DeepfreezePluginSetupDeps {
  management: ManagementSetup;
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
