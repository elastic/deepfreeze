import { schema } from '@kbn/config-schema';
import type { IRouter, Logger } from '@kbn/core/server';

import { API } from '../../common/api/paths';
import { AuditLogger } from '../audit';
import type { AuditEsClient } from '../audit/types';

/**
 * GET /api/deepfreeze/audit?limit=&action=
 *
 * Returns the most recent audit entries (newest first) from the
 * `deepfreeze-audit` index. Read-only; mutating actions are written by
 * the action routes themselves.
 *
 * Mirrors `GET /audit` in
 *   packages/deepfreeze-server/deepfreeze_server/api/audit.py
 */
export function registerAuditRoute(
  router: IRouter,
  logger: Logger,
  version: string
): void {
  router.get(
    {
      path: API.audit,
      security: {
        authz: {
          enabled: false,
          reason: 'Relies on ES cluster privileges declared on the deepfreeze feature.',
        },
      },
      validate: {
        query: schema.object({
          limit: schema.maybe(schema.number({ min: 1, max: 500 })),
          action: schema.maybe(schema.string()),
        }),
      },
    },
    async (ctx, req, res) => {
      const { client } = (await ctx.core).elasticsearch;
      const esClient = client.asCurrentUser as unknown as AuditEsClient;

      const auditLogger = new AuditLogger(esClient, {
        enabled: true,
        version,
        hostname: 'kibana',
        log: {
          debug: (msg) => logger.debug(msg),
          warn: (msg) => logger.warn(msg),
        },
      });

      const entries = await auditLogger.getRecentEntries({
        limit: req.query.limit,
        actionFilter: req.query.action,
      });

      return res.ok({ body: { entries, source: 'es' } });
    }
  );
}
