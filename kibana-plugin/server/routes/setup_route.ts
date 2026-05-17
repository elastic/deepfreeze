import { schema } from '@kbn/config-schema';
import type { IRouter, KibanaRequest, Logger } from '@kbn/core/server';

import { API } from '../../common/api/paths';
import { AuditLogger } from '../audit';
import type { AuditEsClient } from '../audit/types';
import {
  getSetupOptions,
  runSetup,
  runSetupDryRun,
  type SetupActionEsClient,
  type SetupConfig,
} from '../actions/setup';
import { PreconditionError } from '../errors';

/**
 * Shared body schema for both setup endpoints.
 *
 * Provider/rotation/style are validated against literal unions so the
 * action's typed inputs are guaranteed at the boundary; rich defaults
 * are pushed to the wizard UI (Step 3) rather than baked in here.
 */
const setupBodySchema = schema.object({
  repo_name_prefix: schema.string({ minLength: 1 }),
  bucket_name_prefix: schema.string({ minLength: 1 }),
  base_path_prefix: schema.string({ minLength: 1 }),
  canned_acl: schema.string({ minLength: 1 }),
  storage_class: schema.string({ minLength: 1 }),
  provider: schema.oneOf([
    schema.literal('aws'),
    schema.literal('azure'),
    schema.literal('gcp'),
  ]),
  rotate_by: schema.oneOf([schema.literal('path'), schema.literal('bucket')]),
  style: schema.oneOf([schema.literal('oneup'), schema.literal('date')]),
  year: schema.maybe(schema.number({ min: 1900, max: 9999 })),
  month: schema.maybe(schema.number({ min: 1, max: 12 })),
  ilm_policy_name: schema.maybe(schema.string({ minLength: 1 })),
  index_template_name: schema.maybe(schema.string({ minLength: 1 })),
});

/**
 * Dependency-injection seam for getting the username out of the request.
 * Defaults to 'kibana' when the optional security plugin is absent so
 * audit rows are still meaningfully attributed.
 */
export type GetCurrentUser = (request: KibanaRequest) => Promise<string>;

export interface RegisterSetupRouteOptions {
  router: IRouter;
  logger: Logger;
  /** Plugin version included in audit rows. */
  version: string;
  /** Resolve the requesting user's name for audit logging. */
  getCurrentUser: GetCurrentUser;
}

/**
 * Register all three Setup routes:
 *   - GET  /api/deepfreeze/setup/options
 *   - POST /api/deepfreeze/setup/dry-run
 *   - POST /api/deepfreeze/setup
 *
 * Authz is delegated to ES — the requestor must hold the cluster
 * privileges ES checks for `_snapshot/_all`, `put_lifecycle`, and the
 * index-template endpoints. The plugin's own UI gate is `monitor`,
 * but Setup will surface ES 403s back to the wizard verbatim if the
 * user lacks the write privileges to complete the run.
 */
export function registerSetupRoute({
  router,
  logger,
  version,
  getCurrentUser,
}: RegisterSetupRouteOptions): void {
  router.get(
    {
      path: API.setupOptions,
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
      const esClient = client.asCurrentUser as unknown as SetupActionEsClient;
      const options = await getSetupOptions(esClient);
      return res.ok({ body: options });
    }
  );

  router.post(
    {
      path: API.setupDryRun,
      security: {
        authz: {
          enabled: false,
          reason: 'Relies on ES cluster privileges declared on the deepfreeze feature.',
        },
      },
      validate: { body: setupBodySchema },
    },
    async (ctx, req, res) => {
      const { client } = (await ctx.core).elasticsearch;
      const esClient = client.asCurrentUser as unknown as SetupActionEsClient;

      try {
        const result = await runSetupDryRun(esClient, req.body as SetupConfig);
        return res.ok({ body: result });
      } catch (err) {
        if (err instanceof PreconditionError) {
          return res.customError({
            statusCode: 400,
            body: { message: err.message, attributes: { issues: err.issues } },
          });
        }
        throw err;
      }
    }
  );

  router.post(
    {
      path: API.setup,
      security: {
        authz: {
          enabled: false,
          reason: 'Relies on ES cluster privileges declared on the deepfreeze feature.',
        },
      },
      validate: { body: setupBodySchema },
    },
    async (ctx, req, res) => {
      const { client } = (await ctx.core).elasticsearch;
      const esClient = client.asCurrentUser as unknown as SetupActionEsClient;
      const config = req.body as SetupConfig;
      const user = await getCurrentUser(req);

      const auditLogger = new AuditLogger(esClient as unknown as AuditEsClient, {
        enabled: true,
        version,
        hostname: 'kibana',
        log: {
          debug: (m) => logger.debug(m),
          warn: (m) => logger.warn(m),
        },
      });

      const parameters = redactParameters(config);

      try {
        const result = await auditLogger.track(
          { action: 'setup', dryRun: false, parameters, user },
          async (tracker) => {
            const out = await runSetup(esClient, config, {
              log: {
                debug: (m) => logger.debug(m),
                warn: (m) => logger.warn(m),
              },
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
              repository: out.new_repo_name,
              bucket: out.new_bucket,
              base_path: out.new_base_path,
            });
            for (const e of out.errors) {
              tracker.addError({ code: e.code, message: e.message });
            }
            return out;
          }
        );
        return res.ok({ body: result });
      } catch (err) {
        if (err instanceof PreconditionError) {
          return res.customError({
            statusCode: 400,
            body: { message: err.message, attributes: { issues: err.issues } },
          });
        }
        throw err;
      }
    }
  );
}

/**
 * Strip out fields we don't want recorded verbatim in the audit row.
 * Currently a placeholder — none of the Setup params are sensitive
 * (no credentials are accepted as form input; those live in the
 * Kibana keystore), but the seam exists so future fields can opt out.
 */
function redactParameters(config: SetupConfig): Record<string, unknown> {
  return { ...config };
}
