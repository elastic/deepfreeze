import type { ElasticsearchClient } from '@kbn/core/server';
import type { UsageCollectionSetup } from '@kbn/usage-collection-plugin/server';

import type { StatusActionEsClient } from '../actions/status';
import { fetchDeepfreezeUsage } from './fetch';
import { deepfreezeUsageSchema } from './schema';
import type { DeepfreezeUsageData } from './types';

export interface RegisterUsageCollectorOptions {
  usageCollection: UsageCollectionSetup;
}

/**
 * Register the deepfreeze usage collector with Kibana's telemetry
 * system. Caller is responsible for honoring the
 * `xpack.deepfreeze.telemetry.enabled` config flag — this function
 * registers unconditionally.
 *
 * The collector is keyed on `deepfreeze`; payload shape is the
 * `DeepfreezeUsageData` interface.
 */
export function registerDeepfreezeUsageCollector({
  usageCollection,
}: RegisterUsageCollectorOptions): void {
  const collector = usageCollection.makeUsageCollector<DeepfreezeUsageData>({
    type: 'deepfreeze',
    isReady: () => true,
    schema: deepfreezeUsageSchema,
    fetch: async ({ esClient }: { esClient: ElasticsearchClient }) => {
      return fetchDeepfreezeUsage(esClient as unknown as StatusActionEsClient);
    },
  });

  usageCollection.registerCollector(collector);
}
