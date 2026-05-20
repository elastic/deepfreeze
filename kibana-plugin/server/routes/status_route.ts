import type { IRouter, Logger } from '@kbn/core/server';

import { API } from '../../common/api/paths';
import { runStatus, type StatusActionEsClient } from '../actions/status';
import { getSettings } from '../repositories/settings_repo';
import {
  storageClientFactory,
  type AwsStorageClientOptions,
} from '../storage/factory';
import type { StorageClient } from '../storage/types';

export interface StatusRouteStorageOptions {
  aws?: AwsStorageClientOptions;
}

export interface RegisterStatusRouteOptions {
  router: IRouter;
  logger: Logger;
  storageOptions?: StatusRouteStorageOptions;
}

/**
 * GET /api/deepfreeze/status
 *
 * Returns the full SystemStatus (cluster health, settings, repositories,
 * thaw requests, ILM policies) for the configured Elasticsearch cluster.
 *
 * Errors are folded into the response body (`initialized: false` /
 * `errors[]`) rather than thrown — see `runStatus` for the contract.
 *
 * A best-effort StorageClient is constructed when the cluster is
 * initialized so each repo gets a sampled `storage_tier`. If storage
 * init fails (no provider configured, no creds, etc.) we omit the
 * client and proceed — status without tier info is still useful.
 */
export function registerStatusRoute(
  routerOrOptions: IRouter | RegisterStatusRouteOptions,
  legacyLogger?: Logger
): void {
  // Tolerate both the legacy two-arg form (router, logger) and the
  // options form so plugin.ts callers can migrate at their own pace.
  const opts: RegisterStatusRouteOptions =
    legacyLogger !== undefined
      ? { router: routerOrOptions as IRouter, logger: legacyLogger }
      : (routerOrOptions as RegisterStatusRouteOptions);

  const { router, logger, storageOptions } = opts;

  router.get(
    {
      path: API.status,
      // Authz delegated to ES: requestor must have the cluster
      // privileges declared on the plugin's ES feature.
      security: {
        authz: {
          enabled: false,
          reason: 'Relies on ES cluster privileges declared on the deepfreeze feature.',
        },
      },
      validate: false,
    },
    async (ctx, _req, res) => {
      const { client } = (await ctx.core).elasticsearch;
      const esClient = client.asCurrentUser as unknown as StatusActionEsClient;

      const storage = await tryBuildStorage(esClient, storageOptions, logger);

      const result = await runStatus(esClient, {
        log: {
          debug: (msg) => logger.debug(msg),
          warn: (msg) => logger.warn(msg),
        },
        storage,
      });

      return res.ok({ body: result });
    }
  );
}

/**
 * Build a StorageClient for the sampling phase, swallowing all errors
 * — status must keep working when storage is unconfigured, the
 * provider isn't supported yet, or the SDK throws. We return
 * `undefined` in those cases and skip sampling.
 */
async function tryBuildStorage(
  esClient: StatusActionEsClient,
  storageOptions: StatusRouteStorageOptions | undefined,
  logger: Logger
): Promise<StorageClient | undefined> {
  try {
    const settings = await getSettings(esClient);
    if (!settings) return undefined;
    return await storageClientFactory(settings.provider, storageOptions?.aws ?? {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug(
      `Status: storage client unavailable; skipping tier sampling (${msg})`
    );
    return undefined;
  }
}
