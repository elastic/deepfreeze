import { schema } from '@kbn/config-schema';
import type { IRouter, Logger } from '@kbn/core/server';

import { API } from '../../common/api/paths';
import { AuditLogger } from '../audit';
import type { AuditEsClient } from '../audit/types';
import {
  runRotate,
  runRotateDryRun,
  type RotateActionEsClient,
  type RotateConfig,
} from '../actions/rotate';
import { ActionError, MissingIndexError, MissingSettingsError } from '../errors';
import type { GetCurrentUser } from './setup_route';

const rotateBodySchema = schema.object({
  keep: schema.maybe(schema.number({ min: 0, max: 1000 })),
  year: schema.maybe(schema.number({ min: 1900, max: 9999 })),
  month: schema.maybe(schema.number({ min: 1, max: 12 })),
  dry_run: schema.maybe(schema.boolean()),
});

export interface RegisterRotateRouteOptions {
  router: IRouter;
  logger: Logger;
  version: string;
  getCurrentUser: GetCurrentUser;
}

/**
 * POST /api/deepfreeze/rotate
 *
 * Body: { keep?, year?, month?, dry_run? }. `dry_run: true` skips all
 * writes and returns the preview. Mutating runs are wrapped in
 * `AuditLogger.track` so the audit row is committed even on failure.
 */
export function registerRotateRoute({
  router,
  logger,
  version,
  getCurrentUser,
}: RegisterRotateRouteOptions): void {
  router.post(
    {
      path: API.rotate,
      security: {
        authz: {
          enabled: false,
          reason: 'Relies on ES cluster privileges declared on the deepfreeze feature.',
        },
      },
      validate: { body: rotateBodySchema },
    },
    async (ctx, req, res) => {
      const { client } = (await ctx.core).elasticsearch;
      const esClient = client.asCurrentUser as unknown as RotateActionEsClient;
      const { dry_run, ...config } = req.body as RotateConfig & { dry_run?: boolean };

      try {
        if (dry_run) {
          const result = await runRotateDryRun(esClient, config);
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
          { action: 'rotate', dryRun: false, parameters: { ...config }, user },
          async (tracker) => {
            const out = await runRotate(esClient, config, {
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
              new_repo: out.new_repo_name,
              archived_count: out.archived.length,
              skipped_count: out.skipped.length,
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
