/**
 * POST /api/deepfreeze/repair-metadata
 *
 * Scans every RepositoryDoc against actual S3 storage state and either
 * reports discrepancies (dry-run) or applies them. Audited as
 * `repair_metadata`. AWS-only until other storage adapters land.
 */

import { schema } from '@kbn/config-schema';
import type { IRouter, Logger } from '@kbn/core/server';

import { API } from '../../common/api/paths';
import { AuditLogger } from '../audit';
import type { AuditEsClient } from '../audit/types';
import {
  runRepairMetadata,
  runRepairMetadataDryRun,
  type RepairMetadataActionEsClient,
} from '../actions/repair_metadata';
import { ActionError, MissingIndexError, MissingSettingsError } from '../errors';
import { getSettings } from '../repositories/settings_repo';
import {
  storageClientFactory,
  type AwsStorageClientOptions,
} from '../storage/factory';
import type { GetCurrentUser } from './setup_route';

const bodySchema = schema.object({
  dry_run: schema.maybe(schema.boolean()),
});

export interface RegisterRepairMetadataRouteOptions {
  router: IRouter;
  logger: Logger;
  version: string;
  getCurrentUser: GetCurrentUser;
  storageOptions?: { aws?: AwsStorageClientOptions };
}

export function registerRepairMetadataRoute({
  router,
  logger,
  version,
  getCurrentUser,
  storageOptions,
}: RegisterRepairMetadataRouteOptions): void {
  router.post(
    {
      path: API.repairMetadata,
      security: {
        authz: {
          enabled: false,
          reason: 'Relies on ES cluster privileges declared on the deepfreeze feature.',
        },
      },
      validate: { body: bodySchema },
    },
    async (ctx, req, res) => {
      const { client } = (await ctx.core).elasticsearch;
      const esClient =
        client.asCurrentUser as unknown as RepairMetadataActionEsClient;
      const { dry_run } = req.body as { dry_run?: boolean };

      try {
        // Load settings to derive provider for the StorageClient.
        const settings = await getSettings(esClient);
        if (!settings) {
          throw new MissingSettingsError('Settings document not found in status index');
        }
        const storage = await storageClientFactory(
          settings.provider,
          storageOptions?.aws ?? {}
        );

        if (dry_run) {
          const result = await runRepairMetadataDryRun(esClient, storage, {
            log: { debug: (m) => logger.debug(m), warn: (m) => logger.warn(m) },
          });
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
          { action: 'repair_metadata', dryRun: false, parameters: {}, user },
          async (tracker) => {
            const out = await runRepairMetadata(esClient, storage, {
              log: { debug: (m) => logger.debug(m), warn: (m) => logger.warn(m) },
            });
            for (const r of out.repaired) {
              tracker.addResult({
                type: 'repository',
                action: 'repaired',
                target: r.repo,
                detail: `${r.from} → ${r.to}`,
              });
            }
            for (const f of out.failed) {
              tracker.addResult({
                type: 'repository',
                action: 'failed',
                target: f.repo,
                detail: f.error ?? '',
              });
            }
            for (const d of out.date_ranges) {
              if (!d.changed) continue;
              tracker.addResult({
                type: 'repository',
                action: 'date_range_set',
                target: d.repo,
                detail: `${d.start ?? '?'} → ${d.end ?? '?'}`,
              });
            }
            tracker.setSummary({
              discrepancies: out.discrepancies.length,
              repaired_count: out.repaired.length,
              failed_count: out.failed.length,
              date_ranges_changed: out.date_ranges.filter((d) => d.changed).length,
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
        if (err instanceof Error && /not implemented yet/i.test(err.message)) {
          return res.customError({
            statusCode: 501,
            body: { message: err.message, attributes: { code: 'NOT_IMPLEMENTED' } },
          });
        }
        throw err;
      }
    }
  );
}
