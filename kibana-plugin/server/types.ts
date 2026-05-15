import type { FeaturesPluginSetup } from '@kbn/features-plugin/server';
import type {
  TaskManagerSetupContract,
  TaskManagerStartContract,
} from '@kbn/task-manager-plugin/server';
import type { SecurityPluginStart } from '@kbn/security-plugin/server';
import type { UsageCollectionSetup } from '@kbn/usage-collection-plugin/server';

/**
 * Other plugins this plugin depends on during the `setup` lifecycle.
 *
 * `requiredPlugins` from `kibana.jsonc` must be reflected here; optional
 * deps use `?`.
 */
export interface DeepfreezePluginSetupDeps {
  features: FeaturesPluginSetup;
  taskManager: TaskManagerSetupContract;
  usageCollection?: UsageCollectionSetup;
}

export interface DeepfreezePluginStartDeps {
  taskManager: TaskManagerStartContract;
  security?: SecurityPluginStart;
}

/** Contract exposed to other plugins during `setup`. */
export interface DeepfreezePluginSetup {
  /** Reserved for future API. */
  readonly _empty?: never;
}

/** Contract exposed to other plugins during `start`. */
export interface DeepfreezePluginStart {
  readonly _empty?: never;
}
