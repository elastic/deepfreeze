import type { IRouter, Logger } from '@kbn/core/server';

import { API } from '../../common/api/paths';
import { runStatus, type StatusActionEsClient } from '../actions/status';

/**
 * GET /api/deepfreeze/status
 *
 * Returns the full SystemStatus (cluster health, settings, repositories,
 * thaw requests, ILM policies) for the configured Elasticsearch cluster.
 *
 * Errors are folded into the response body (`initialized: false` /
 * `errors[]`) rather than thrown — see `runStatus` for the contract.
 */
export function registerStatusRoute(router: IRouter, logger: Logger): void {
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

      const result = await runStatus(esClient, {
        log: {
          debug: (msg) => logger.debug(msg),
          warn: (msg) => logger.warn(msg),
        },
      });

      return res.ok({ body: result });
    }
  );
}
