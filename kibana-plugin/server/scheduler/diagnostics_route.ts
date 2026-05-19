/**
 * GET /api/deepfreeze/scheduler/diagnostics
 *
 * Operator-visible state for the scheduler bootstrap. Returns:
 *   - Outcome of the last plugin-start bootstrap (counts + per-job
 *     entries)
 *   - Live count of `scheduled_job` docs visible to the internal user
 *     (i.e. the user the bootstrap reads as)
 *   - Live count of `scheduled_job` docs visible to the current user
 *     (for comparison — if the two differ, it's a permissions issue)
 *
 * No re-run capability for now. To force a new bootstrap, restart
 * Kibana. The CRUD routes (Step 3) will keep TaskManager in sync
 * on every doc mutation without requiring a restart.
 */

import type { IRouter, Logger } from '@kbn/core/server';

import { DOCTYPE, STATUS_INDEX } from '../../common/constants';
import type { BootstrapDeepfreezeSchedulesResult } from './bootstrap';

/**
 * Mutable holder for the bootstrap result. The plugin instance owns
 * one of these and passes it into both the bootstrap (which writes)
 * and the diagnostics route (which reads). Captures the moment of the
 * last bootstrap so operators can see "when did this last run" even
 * when reading from a long-uptime Kibana.
 */
export interface SchedulerDiagnosticsState {
  last_bootstrap_at: string | null;
  last_result: BootstrapDeepfreezeSchedulesResult | null;
  last_error: string | null;
}

export function createSchedulerDiagnosticsState(): SchedulerDiagnosticsState {
  return {
    last_bootstrap_at: null,
    last_result: null,
    last_error: null,
  };
}

interface MinimalEsClient {
  search: (params: {
    index: string;
    query?: Record<string, unknown>;
    size?: number;
  }) => Promise<{
    hits: {
      total?: { value: number } | number;
      hits: Array<{ _id: string }>;
    };
  }>;
}

/**
 * Count `scheduled_job` docs visible to the given client. Defensively
 * returns `{count: -1, error}` instead of throwing so the diagnostic
 * can still render the rest of the picture even when one side errors.
 */
async function countScheduledJobs(
  client: MinimalEsClient
): Promise<{ count: number; error: string | null }> {
  try {
    const resp = await client.search({
      index: STATUS_INDEX,
      query: { term: { doctype: DOCTYPE.scheduled_job } },
      size: 0,
    });
    const total = resp.hits.total;
    const count = typeof total === 'number' ? total : total?.value ?? 0;
    return { count, error: null };
  } catch (err) {
    return {
      count: -1,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface RegisterSchedulerDiagnosticsRouteOptions {
  router: IRouter;
  logger: Logger;
  /** Live reference to the holder mutated by the plugin's start() hook. */
  state: SchedulerDiagnosticsState;
}

export function registerSchedulerDiagnosticsRoute({
  router,
  logger: _logger,
  state,
}: RegisterSchedulerDiagnosticsRouteOptions): void {
  router.get(
    {
      path: '/api/deepfreeze/scheduler/diagnostics',
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

      const [asCurrent, asInternal] = await Promise.all([
        countScheduledJobs(client.asCurrentUser as unknown as MinimalEsClient),
        countScheduledJobs(client.asInternalUser as unknown as MinimalEsClient),
      ]);

      return res.ok({
        body: {
          last_bootstrap_at: state.last_bootstrap_at,
          last_result: state.last_result,
          last_error: state.last_error,
          visible_to_current_user: asCurrent,
          visible_to_internal_user: asInternal,
          permissions_mismatch:
            asCurrent.count !== asInternal.count &&
            asCurrent.error === null &&
            asInternal.error === null,
        },
      });
    }
  );
}
