/**
 * HTTP routes for scheduled-job CRUD:
 *
 *   GET    /api/deepfreeze/schedules                       — list
 *   POST   /api/deepfreeze/schedules                       — create
 *   GET    /api/deepfreeze/schedules/{name}                — get one
 *   PUT    /api/deepfreeze/schedules/{name}                — update
 *   DELETE /api/deepfreeze/schedules/{name}                — remove
 *   POST   /api/deepfreeze/schedules/{name}/pause          — paused: true
 *   POST   /api/deepfreeze/schedules/{name}/resume         — paused: false
 *   POST   /api/deepfreeze/schedules/{name}/run-now        — fire synchronously
 *
 * Dual-write semantics: every mutation persists the scheduled_job doc
 * in `deepfreeze-status` first, then syncs Kibana TaskManager
 * (`ensureScheduled` / `removeIfExists`). ES-first ordering is
 * deliberate — if TaskManager sync fails after the doc is saved, the
 * operator can retry by re-PUTting; if we sync TaskManager first and
 * then fail the persist, the task fires on its schedule but no doc
 * references it (worse).
 *
 * Mutating routes are audited as `create_schedule`, `update_schedule`,
 * etc. so the Activity tab shows who managed which schedules.
 */

import { schema } from '@kbn/config-schema';
import type { IRouter, Logger } from '@kbn/core/server';
import type { TaskManagerStartContract } from '@kbn/task-manager-plugin/server';

import { API } from '../../common/api/paths';
import type { ScheduledJobDoc } from '../../common/schemas/scheduled_job';
import { AuditLogger } from '../audit';
import type { AuditEsClient } from '../audit/types';
import { ActionError } from '../errors';
import {
  deleteScheduledJob,
  getAllScheduledJobs,
  getScheduledJob,
  saveScheduledJob,
  type ScheduledJobRepoWriteEsClient,
} from '../repositories/scheduled_job_repo';
import { bootstrapTaskId } from './bootstrap';
import { runActionForSchedule, syncTaskManager } from './sync';
import type { RotateActionEsClient } from '../actions/rotate';
import type { CleanupActionEsClient } from '../actions/cleanup';
import type { RepairMetadataActionEsClient } from '../actions/repair_metadata';
import type { AwsStorageClientOptions } from '../storage/factory';
import type { GetCurrentUser } from '../routes/setup_route';

/** Allowed `action` values; anything else gets rejected at the route. */
const SCHEDULE_ACTIONS = ['rotate', 'cleanup', 'repair_metadata'] as const;

const nameParamSchema = schema.object({
  name: schema.string({
    minLength: 1,
    maxLength: 200,
    // Permit alphanumerics, dashes, underscores. The doc id is built
    // as `scheduled_job:<name>` and we don't want path/URL surprises.
    validate: (val) => {
      if (!/^[A-Za-z0-9_-]+$/.test(val)) {
        return 'name must be alphanumerics, dashes, or underscores only';
      }
    },
  }),
});

const createBodySchema = schema.object({
  name: schema.string({ minLength: 1, maxLength: 200 }),
  action: schema.oneOf([
    schema.literal('rotate'),
    schema.literal('cleanup'),
    schema.literal('repair_metadata'),
  ]),
  params: schema.maybe(schema.recordOf(schema.string(), schema.any())),
  interval_seconds: schema.number({ min: 1, max: 365 * 24 * 60 * 60 }),
  paused: schema.maybe(schema.boolean()),
});

const updateBodySchema = schema.object({
  action: schema.maybe(
    schema.oneOf([
      schema.literal('rotate'),
      schema.literal('cleanup'),
      schema.literal('repair_metadata'),
    ])
  ),
  params: schema.maybe(schema.recordOf(schema.string(), schema.any())),
  interval_seconds: schema.maybe(
    schema.number({ min: 1, max: 365 * 24 * 60 * 60 })
  ),
  paused: schema.maybe(schema.boolean()),
});

export type SchedulesEsClient = ScheduledJobRepoWriteEsClient &
  AuditEsClient &
  RotateActionEsClient &
  CleanupActionEsClient &
  RepairMetadataActionEsClient;

export interface RegisterSchedulesRouteOptions {
  router: IRouter;
  logger: Logger;
  version: string;
  getCurrentUser: GetCurrentUser;
  /**
   * Resolves to the TaskManager start contract. Captured by plugin
   * setup, fulfilled by plugin start — routes can't reach for
   * core.getStartServices() directly without making async hot paths
   * messy, so this getter pattern keeps the route handlers clean.
   */
  getTaskManager: () => TaskManagerStartContract;
  storageOptions?: { aws?: AwsStorageClientOptions };
}

export function registerSchedulesRoute(
  opts: RegisterSchedulesRouteOptions
): void {
  const { router, logger, version, getCurrentUser, storageOptions } = opts;

  const log = {
    debug: (m: string) => logger.debug(m),
    warn: (m: string) => logger.warn(m),
  };

  function makeAudit(client: AuditEsClient): AuditLogger {
    return new AuditLogger(client, {
      enabled: true,
      version,
      hostname: 'kibana',
      log,
    });
  }

  // --- GET /api/deepfreeze/schedules ---------------------------------
  router.get(
    {
      path: API.schedules,
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
      const esClient = client.asCurrentUser as unknown as SchedulesEsClient;
      const jobs = await getAllScheduledJobs(esClient);
      return res.ok({ body: { schedules: jobs } });
    }
  );

  // --- GET /api/deepfreeze/schedules/{name} --------------------------
  router.get(
    {
      path: API.schedulePattern,
      security: {
        authz: {
          enabled: false,
          reason: 'Relies on ES cluster privileges declared on the deepfreeze feature.',
        },
      },
      validate: { params: nameParamSchema },
    },
    async (ctx, req, res) => {
      const { client } = (await ctx.core).elasticsearch;
      const esClient = client.asCurrentUser as unknown as SchedulesEsClient;
      const { name } = req.params as { name: string };
      const job = await getScheduledJob(esClient, name);
      if (!job) {
        return res.customError({
          statusCode: 404,
          body: { message: `Scheduled job '${name}' not found` },
        });
      }
      return res.ok({ body: job });
    }
  );

  // --- POST /api/deepfreeze/schedules --------------------------------
  router.post(
    {
      path: API.schedules,
      security: {
        authz: {
          enabled: false,
          reason: 'Relies on ES cluster privileges declared on the deepfreeze feature.',
        },
      },
      validate: { body: createBodySchema },
    },
    async (ctx, req, res) => {
      const { client } = (await ctx.core).elasticsearch;
      const esClient = client.asCurrentUser as unknown as SchedulesEsClient;
      const body = req.body as {
        name: string;
        action: (typeof SCHEDULE_ACTIONS)[number];
        params?: Record<string, unknown>;
        interval_seconds: number;
        paused?: boolean;
      };

      if (!/^[A-Za-z0-9_-]+$/.test(body.name)) {
        return res.customError({
          statusCode: 400,
          body: {
            message:
              "Schedule 'name' must be alphanumerics, dashes, or underscores only",
          },
        });
      }

      const existing = await getScheduledJob(esClient, body.name);
      if (existing) {
        return res.customError({
          statusCode: 409,
          body: {
            message: `Scheduled job '${body.name}' already exists`,
          },
        });
      }

      const doc: ScheduledJobDoc = {
        doctype: 'scheduled_job',
        name: body.name,
        action: body.action,
        params: body.params ?? {},
        cron: null,
        interval_seconds: body.interval_seconds,
        paused: body.paused ?? false,
        created_at: new Date().toISOString(),
      };

      try {
        const user = await getCurrentUser(req);
        const audit = makeAudit(esClient);
        await audit.track(
          {
            action: 'create_schedule',
            dryRun: false,
            parameters: {
              name: doc.name,
              action: doc.action,
              interval_seconds: doc.interval_seconds,
              paused: doc.paused,
            },
            user,
          },
          async (tracker) => {
            await saveScheduledJob(esClient, doc);
            const sync = await syncTaskManager(opts.getTaskManager(), doc);
            tracker.addResult({
              type: 'scheduled_job',
              action: 'created',
              target: doc.name,
              detail: `sync: ${sync}`,
            });
          }
        );
        return res.ok({ body: doc });
      } catch (err) {
        return mapError(err, res);
      }
    }
  );

  // --- PUT /api/deepfreeze/schedules/{name} --------------------------
  router.put(
    {
      path: API.schedulePattern,
      security: {
        authz: {
          enabled: false,
          reason: 'Relies on ES cluster privileges declared on the deepfreeze feature.',
        },
      },
      validate: { params: nameParamSchema, body: updateBodySchema },
    },
    async (ctx, req, res) => {
      const { client } = (await ctx.core).elasticsearch;
      const esClient = client.asCurrentUser as unknown as SchedulesEsClient;
      const { name } = req.params as { name: string };
      const patch = req.body as {
        action?: (typeof SCHEDULE_ACTIONS)[number];
        params?: Record<string, unknown>;
        interval_seconds?: number;
        paused?: boolean;
      };

      const existing = await getScheduledJob(esClient, name);
      if (!existing) {
        return res.customError({
          statusCode: 404,
          body: { message: `Scheduled job '${name}' not found` },
        });
      }

      const updated: ScheduledJobDoc = {
        ...existing,
        action: patch.action ?? existing.action,
        params: patch.params ?? existing.params,
        interval_seconds: patch.interval_seconds ?? existing.interval_seconds,
        paused: patch.paused ?? existing.paused,
      };

      try {
        const user = await getCurrentUser(req);
        const audit = makeAudit(esClient);
        await audit.track(
          {
            action: 'update_schedule',
            dryRun: false,
            parameters: { name, ...patch },
            user,
          },
          async (tracker) => {
            await saveScheduledJob(esClient, updated);
            const sync = await syncTaskManager(opts.getTaskManager(), updated);
            tracker.addResult({
              type: 'scheduled_job',
              action: 'updated',
              target: name,
              detail: `sync: ${sync}`,
            });
          }
        );
        return res.ok({ body: updated });
      } catch (err) {
        return mapError(err, res);
      }
    }
  );

  // --- DELETE /api/deepfreeze/schedules/{name} -----------------------
  router.delete(
    {
      path: API.schedulePattern,
      security: {
        authz: {
          enabled: false,
          reason: 'Relies on ES cluster privileges declared on the deepfreeze feature.',
        },
      },
      validate: { params: nameParamSchema },
    },
    async (ctx, req, res) => {
      const { client } = (await ctx.core).elasticsearch;
      const esClient = client.asCurrentUser as unknown as SchedulesEsClient;
      const { name } = req.params as { name: string };
      try {
        const user = await getCurrentUser(req);
        const audit = makeAudit(esClient);
        await audit.track(
          {
            action: 'delete_schedule',
            dryRun: false,
            parameters: { name },
            user,
          },
          async (tracker) => {
            await deleteScheduledJob(esClient, name);
            // Remove from TaskManager whether or not the doc existed —
            // a stranded task instance is the worse failure mode.
            await opts.getTaskManager().removeIfExists(bootstrapTaskId(name));
            tracker.addResult({
              type: 'scheduled_job',
              action: 'deleted',
              target: name,
            });
          }
        );
        return res.ok({ body: { deleted: name } });
      } catch (err) {
        return mapError(err, res);
      }
    }
  );

  // --- POST /api/deepfreeze/schedules/{name}/pause -------------------
  router.post(
    {
      path: API.schedulePausePattern,
      security: {
        authz: {
          enabled: false,
          reason: 'Relies on ES cluster privileges declared on the deepfreeze feature.',
        },
      },
      validate: { params: nameParamSchema },
    },
    async (ctx, req, res) =>
      togglePaused(ctx, req, res, true, esClientFromCtx, opts, getCurrentUser, makeAudit)
  );

  // --- POST /api/deepfreeze/schedules/{name}/resume ------------------
  router.post(
    {
      path: API.scheduleResumePattern,
      security: {
        authz: {
          enabled: false,
          reason: 'Relies on ES cluster privileges declared on the deepfreeze feature.',
        },
      },
      validate: { params: nameParamSchema },
    },
    async (ctx, req, res) =>
      togglePaused(ctx, req, res, false, esClientFromCtx, opts, getCurrentUser, makeAudit)
  );

  // --- POST /api/deepfreeze/schedules/{name}/run-now -----------------
  router.post(
    {
      path: API.scheduleRunNowPattern,
      security: {
        authz: {
          enabled: false,
          reason: 'Relies on ES cluster privileges declared on the deepfreeze feature.',
        },
      },
      validate: { params: nameParamSchema },
    },
    async (ctx, req, res) => {
      const { client } = (await ctx.core).elasticsearch;
      const esClient = client.asCurrentUser as unknown as SchedulesEsClient;
      const { name } = req.params as { name: string };

      const job = await getScheduledJob(esClient, name);
      if (!job) {
        return res.customError({
          statusCode: 404,
          body: { message: `Scheduled job '${name}' not found` },
        });
      }

      try {
        const user = await getCurrentUser(req);
        const audit = makeAudit(esClient);
        const result = await audit.track(
          {
            action: 'run_schedule_now',
            dryRun: false,
            parameters: { name, action: job.action, triggered_by: 'manual' },
            user,
          },
          async (tracker) => {
            const actionResult = await runActionForSchedule(
              esClient,
              job,
              { log, storageOptions }
            );
            tracker.addResult({
              type: 'scheduled_job',
              action: 'ran',
              target: name,
              detail: `action: ${job.action}`,
            });
            return actionResult;
          }
        );
        return res.ok({ body: result as Record<string, unknown> });
      } catch (err) {
        return mapError(err, res);
      }
    }
  );
}

/**
 * Shared body for the pause/resume routes — same shape, only differs
 * by the boolean it flips.
 */
async function togglePaused(
  ctx: Parameters<Parameters<IRouter['post']>[1]>[0],
  req: Parameters<Parameters<IRouter['post']>[1]>[1],
  res: Parameters<Parameters<IRouter['post']>[1]>[2],
  paused: boolean,
  esClientFromCtxFn: typeof esClientFromCtx,
  opts: RegisterSchedulesRouteOptions,
  getCurrentUser: GetCurrentUser,
  makeAudit: (client: AuditEsClient) => AuditLogger
) {
  const esClient = await esClientFromCtxFn(ctx);
  const { name } = req.params as { name: string };
  const existing = await getScheduledJob(esClient, name);
  if (!existing) {
    return res.customError({
      statusCode: 404,
      body: { message: `Scheduled job '${name}' not found` },
    });
  }
  if (existing.paused === paused) {
    // No-op — already in the requested state. Don't audit a non-change.
    return res.ok({ body: existing });
  }
  const updated: ScheduledJobDoc = { ...existing, paused };
  try {
    const user = await getCurrentUser(req);
    const audit = makeAudit(esClient);
    await audit.track(
      {
        action: paused ? 'pause_schedule' : 'resume_schedule',
        dryRun: false,
        parameters: { name },
        user,
      },
      async (tracker) => {
        await saveScheduledJob(esClient, updated);
        const sync = await syncTaskManager(opts.getTaskManager(), updated);
        tracker.addResult({
          type: 'scheduled_job',
          action: paused ? 'paused' : 'resumed',
          target: name,
          detail: `sync: ${sync}`,
        });
      }
    );
    return res.ok({ body: updated });
  } catch (err) {
    return mapError(err, res);
  }
}

async function esClientFromCtx(
  ctx: Parameters<Parameters<IRouter['post']>[1]>[0]
): Promise<SchedulesEsClient> {
  const { client } = (await ctx.core).elasticsearch;
  return client.asCurrentUser as unknown as SchedulesEsClient;
}

function mapError(
  err: unknown,
  res: Parameters<Parameters<IRouter['post']>[1]>[2]
) {
  if (err instanceof ActionError) {
    return res.customError({
      statusCode: 400,
      body: { message: err.message, attributes: { code: err.name } },
    });
  }
  throw err;
}
