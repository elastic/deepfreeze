import { schema } from '@kbn/config-schema';
import type { IRouter, Logger } from '@kbn/core/server';

import { API } from '../../common/api/paths';
import { AuditLogger } from '../audit';
import type { AuditEsClient } from '../audit/types';
import {
  runCleanup,
  runCleanupDryRun,
  type CleanupActionEsClient,
  type CleanupConfig,
} from '../actions/cleanup';
import { MissingIndexError, MissingSettingsError } from '../errors';
import type { GetCurrentUser } from './setup_route';

const cleanupBodySchema = schema.object({
  retention_days_completed: schema.maybe(schema.number({ min: 0, max: 36500 })),
  retention_days_failed: schema.maybe(schema.number({ min: 0, max: 36500 })),
  retention_days_refrozen: schema.maybe(schema.number({ min: 0, max: 36500 })),
  dry_run: schema.maybe(schema.boolean()),
});

export interface RegisterCleanupRouteOptions {
  router: IRouter;
  logger: Logger;
  version: string;
  getCurrentUser: GetCurrentUser;
}

/**
 * POST /api/deepfreeze/cleanup
 *
 * Body: { retention_days_completed?, retention_days_failed?,
 *         retention_days_refrozen?, dry_run? }. Real runs are wrapped
 * in `AuditLogger.track`. Dry-runs are not audited.
 */
export function registerCleanupRoute({
  router,
  logger,
  version,
  getCurrentUser,
}: RegisterCleanupRouteOptions): void {
  router.post(
    {
      path: API.cleanup,
      security: {
        authz: {
          enabled: false,
          reason: 'Relies on ES cluster privileges declared on the deepfreeze feature.',
        },
      },
      validate: { body: cleanupBodySchema },
    },
    async (ctx, req, res) => {
      const { client } = (await ctx.core).elasticsearch;
      const esClient = client.asCurrentUser as unknown as CleanupActionEsClient;
      const { dry_run, ...config } = req.body as CleanupConfig & { dry_run?: boolean };

      try {
        if (dry_run) {
          const result = await runCleanupDryRun(esClient, config);
          return res.ok({ body: result });
        }

        const user = await getCurrentUser(req);
        const audit = new AuditLogger(esClient as unknown as AuditEsClient, {
          enabled: true,
          version,
          hostname: 'kibana',
          log: { debug: (m) => logger.debug(m), warn: (m) => logger.warn(m) },
        });

        const result = await audit.track(
          { action: 'cleanup', dryRun: false, parameters: { ...config }, user },
          async (tracker) => {
            const out = await runCleanup(esClient, config, {
              log: { debug: (m) => logger.debug(m), warn: (m) => logger.warn(m) },
            });
            for (const step of out.steps) {
              tracker.addResult({
                type: step.type,
                action: step.action,
                ...(step.name ? { target: step.name } : {}),
                ...(step.detail ? { detail: step.detail } : {}),
              });
            }
            tracker.setSummary({
              deleted_thaw_requests: out.deleted_thaw_requests.length,
              expired_repositories: out.expired_repositories.length,
            });
            for (const e of out.errors) {
              tracker.addError({ code: e.code, message: e.message });
            }
            return out;
          }
        );
        return res.ok({ body: result });
      } catch (err) {
        if (err instanceof MissingIndexError || err instanceof MissingSettingsError) {
          return res.customError({
            statusCode: 400,
            body: { message: err.message, attributes: { code: err.name } },
          });
        }
        throw err;
      }
    }
  );
}
