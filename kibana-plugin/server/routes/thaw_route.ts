/**
 * Thaw HTTP routes:
 *   POST /api/deepfreeze/thaw                       — initiate a thaw
 *   GET  /api/deepfreeze/thaw-requests/{id}/progress — read-only progress
 *   POST /api/deepfreeze/thaw-requests/{id}/check    — progress + mount-when-warm
 *
 * The StorageClient is built per-request via `storageClientFactory`,
 * gated on the configured provider. AWS is the only provider wired up
 * in Phase 4; non-AWS providers surface a structured 501 from the
 * factory's throw.
 */

import { schema } from '@kbn/config-schema';
import type { IRouter, Logger } from '@kbn/core/server';

import { API } from '../../common/api/paths';
import { AuditLogger } from '../audit';
import type { AuditEsClient } from '../audit/types';
import {
  checkAndMaybeMount,
  inspectThawProgress,
  runThaw,
  runThawDryRun,
  type ThawActionEsClient,
  type ThawConfig,
} from '../actions/thaw';
import { ActionError, MissingIndexError, MissingSettingsError } from '../errors';
import { getSettings } from '../repositories/settings_repo';
import {
  storageClientFactory,
  type AwsStorageClientOptions,
} from '../storage/factory';
import type { GetCurrentUser } from './setup_route';

/**
 * Optional AWS-specific knobs passed through to the SDK factory. The
 * plugin doesn't expose these via config yet — they're here so a future
 * config plumb-through (region override / LocalStack endpoint) can be
 * added without touching the route signature.
 */
export interface ThawRouteStorageOptions {
  aws?: AwsStorageClientOptions;
}

const thawBodySchema = schema.object({
  start_date: schema.string({ minLength: 1 }),
  end_date: schema.string({ minLength: 1 }),
  dry_run: schema.maybe(schema.boolean()),
});

const requestIdParamsSchema = schema.object({
  id: schema.string({ minLength: 1 }),
});

export interface RegisterThawRouteOptions {
  router: IRouter;
  logger: Logger;
  version: string;
  getCurrentUser: GetCurrentUser;
  storageOptions?: ThawRouteStorageOptions;
}

/**
 * Build the per-request StorageClient. Always loads settings to derive
 * the provider; throws `MissingSettingsError` upstream if uninitialized
 * so the route handler can map it to a 400 (same as every other action).
 */
async function buildStorageForRequest(
  esClient: ThawActionEsClient,
  storageOptions?: ThawRouteStorageOptions
) {
  const settings = await getSettings(esClient);
  if (!settings) {
    throw new MissingSettingsError('Settings document not found in status index');
  }
  return storageClientFactory(settings.provider, storageOptions?.aws ?? {});
}

function mapErrorToResponse(
  err: unknown,
  res: Parameters<Parameters<IRouter['post']>[1]>[2]
) {
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
  // The storageClientFactory throws a plain Error for non-AWS providers.
  // Map that to 501 so the UI can show a clear "not implemented yet"
  // rather than a generic 500.
  if (err instanceof Error && /not implemented yet/i.test(err.message)) {
    return res.customError({
      statusCode: 501,
      body: { message: err.message, attributes: { code: 'NOT_IMPLEMENTED' } },
    });
  }
  throw err;
}

export function registerThawRoute({
  router,
  logger,
  version,
  getCurrentUser,
  storageOptions,
}: RegisterThawRouteOptions): void {
  // POST /api/deepfreeze/thaw
  router.post(
    {
      path: API.thaw,
      security: {
        authz: {
          enabled: false,
          reason: 'Relies on ES cluster privileges declared on the deepfreeze feature.',
        },
      },
      validate: { body: thawBodySchema },
    },
    async (ctx, req, res) => {
      const { client } = (await ctx.core).elasticsearch;
      const esClient = client.asCurrentUser as unknown as ThawActionEsClient;
      const { dry_run, ...config } = req.body as ThawConfig & { dry_run?: boolean };

      try {
        if (dry_run) {
          const result = await runThawDryRun(esClient, config);
          return res.ok({ body: result });
        }

        const storage = await buildStorageForRequest(esClient, storageOptions);
        const user = await getCurrentUser(req);
        const audit = new AuditLogger(esClient as unknown as AuditEsClient, {
          enabled: true,
          version,
          hostname: 'kibana',
          log: { debug: (m) => logger.debug(m), warn: (m) => logger.warn(m) },
        });

        const result = await audit.track(
          { action: 'thaw', dryRun: false, parameters: { ...config }, user },
          async (tracker) => {
            const out = await runThaw(esClient, storage, config, {
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
              request_id: out.request_id,
              repo_count: out.repos.length,
              repo_object_stats: out.repo_object_stats,
            });
            for (const e of out.errors) {
              tracker.addError({ code: e.code, message: e.message });
            }
            return out;
          }
        );
        return res.ok({ body: result });
      } catch (err) {
        return mapErrorToResponse(err, res);
      }
    }
  );

  // GET /api/deepfreeze/thaw-requests/{id}/progress
  router.get(
    {
      path: API.thawProgressPattern,
      security: {
        authz: {
          enabled: false,
          reason: 'Relies on ES cluster privileges declared on the deepfreeze feature.',
        },
      },
      validate: { params: requestIdParamsSchema },
    },
    async (ctx, req, res) => {
      const { client } = (await ctx.core).elasticsearch;
      const esClient = client.asCurrentUser as unknown as ThawActionEsClient;
      const { id } = req.params as { id: string };
      try {
        const storage = await buildStorageForRequest(esClient, storageOptions);
        const result = await inspectThawProgress(esClient, storage, id);
        return res.ok({ body: result });
      } catch (err) {
        return mapErrorToResponse(err, res);
      }
    }
  );

  // POST /api/deepfreeze/thaw-requests/{id}/check
  router.post(
    {
      path: API.thawCheckPattern,
      security: {
        authz: {
          enabled: false,
          reason: 'Relies on ES cluster privileges declared on the deepfreeze feature.',
        },
      },
      validate: { params: requestIdParamsSchema },
    },
    async (ctx, req, res) => {
      const { client } = (await ctx.core).elasticsearch;
      const esClient = client.asCurrentUser as unknown as ThawActionEsClient;
      const { id } = req.params as { id: string };
      try {
        const storage = await buildStorageForRequest(esClient, storageOptions);
        const user = await getCurrentUser(req);
        const audit = new AuditLogger(esClient as unknown as AuditEsClient, {
          enabled: true,
          version,
          hostname: 'kibana',
          log: { debug: (m) => logger.debug(m), warn: (m) => logger.warn(m) },
        });

        const result = await audit.track(
          { action: 'thaw_check', dryRun: false, parameters: { request_id: id }, user },
          async (tracker) => {
            const out = await checkAndMaybeMount(esClient, storage, id, {
              log: { debug: (m) => logger.debug(m), warn: (m) => logger.warn(m) },
            });
            tracker.setSummary({
              request_id: id,
              status: out.status,
              all_complete: out.all_complete,
              mounted: out.mounted,
              repo_count: out.repos.length,
            });
            for (const e of out.errors) {
              tracker.addError({ code: e.code, message: e.message });
            }
            return out;
          }
        );
        return res.ok({ body: result });
      } catch (err) {
        return mapErrorToResponse(err, res);
      }
    }
  );
}
