import { schema } from '@kbn/config-schema';
import type { IRouter, Logger } from '@kbn/core/server';

import { API } from '../../common/api/paths';
import { AuditLogger } from '../audit';
import type { AuditEsClient } from '../audit/types';
import {
  runRefreeze,
  runRefreezeDryRun,
  type RefreezeActionEsClient,
  type RefreezeConfig,
} from '../actions/refreeze';
import { ActionError, MissingIndexError, MissingSettingsError } from '../errors';
import type { GetCurrentUser } from './setup_route';

const refreezeBodySchema = schema.object({
  request_id: schema.maybe(schema.string({ minLength: 1 })),
  all_requests: schema.maybe(schema.boolean()),
  dry_run: schema.maybe(schema.boolean()),
});

export interface RegisterRefreezeRouteOptions {
  router: IRouter;
  logger: Logger;
  version: string;
  getCurrentUser: GetCurrentUser;
}

/**
 * POST /api/deepfreeze/refreeze
 *
 * Body: { request_id?, all_requests?, dry_run? }. Either request_id
 * or all_requests must be set (action enforces this and throws
 * ActionError → 400 if not).
 */
export function registerRefreezeRoute({
  router,
  logger,
  version,
  getCurrentUser,
}: RegisterRefreezeRouteOptions): void {
  router.post(
    {
      path: API.refreeze,
      security: {
        authz: {
          enabled: false,
          reason: 'Relies on ES cluster privileges declared on the deepfreeze feature.',
        },
      },
      validate: { body: refreezeBodySchema },
    },
    async (ctx, req, res) => {
      const { client } = (await ctx.core).elasticsearch;
      const esClient = client.asCurrentUser as unknown as RefreezeActionEsClient;
      const { dry_run, ...config } = req.body as RefreezeConfig & { dry_run?: boolean };

      try {
        if (dry_run) {
          const result = await runRefreezeDryRun(esClient, config);
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
          { action: 'refreeze', dryRun: false, parameters: { ...config }, user },
          async (tracker) => {
            const out = await runRefreeze(esClient, config, {
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
              refrozen_count: out.refrozen_requests.length,
              rejected_count: out.rejected_requests.length,
            });
            for (const e of out.errors) {
              tracker.addError({ code: e.code, message: e.message });
            }
            return out;
          }
        );
        return res.ok({ body: result });
      } catch (err) {
        if (
          err instanceof MissingIndexError ||
          err instanceof MissingSettingsError ||
          err instanceof ActionError
        ) {
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
