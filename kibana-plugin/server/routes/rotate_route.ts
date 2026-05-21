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
import { getSettings } from '../repositories/settings_repo';
import {
  storageClientFactory,
  type AwsStorageClientOptions,
} from '../storage/factory';
import type { StorageClient } from '../storage/types';
import type { GetCurrentUser } from './setup_route';

export interface RotateRouteStorageOptions {
  aws?: AwsStorageClientOptions;
}

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
  /**
   * Storage options used to construct a `StorageClient` for the
   * refreeze step. When omitted (or when client construction fails),
   * `runRotate` proceeds without a storage client — objects stay in
   * their original storage class and operators rely on bucket-level
   * S3 lifecycle policies.
   */
  storageOptions?: RotateRouteStorageOptions;
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
  storageOptions,
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

        const storage = await tryBuildStorage(esClient, storageOptions, logger);

        const result = await audit.track(
          { action: 'rotate', dryRun: false, parameters: { ...config }, user },
          async (tracker) => {
            const out = await runRotate(esClient, config, {
              log: { debug: (m) => logger.debug(m), warn: (m) => logger.warn(m) },
              storage,
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

/**
 * Build a StorageClient for the refreeze step, swallowing all errors —
 * rotate must keep working when storage is unconfigured, the provider
 * isn't supported yet, or the SDK throws. We return `undefined` in
 * those cases and `runRotate` skips the refreeze step accordingly.
 *
 * Same shape as status_route's `tryBuildStorage`; kept inline here so
 * the logger/log context stays with the rotate route's debug output.
 */
async function tryBuildStorage(
  esClient: RotateActionEsClient,
  storageOptions: RotateRouteStorageOptions | undefined,
  logger: Logger
): Promise<StorageClient | undefined> {
  try {
    const settings = await getSettings(esClient);
    if (!settings) return undefined;
    return await storageClientFactory(settings.provider, storageOptions?.aws ?? {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug(
      `Rotate: storage client unavailable; skipping refreeze step (${msg})`
    );
    return undefined;
  }
}
