/**
 * Kibana SavedObject type for scheduled jobs.
 *
 * Why a SavedObject (not a doc in `deepfreeze-status` like everything
 * else): scheduled jobs are read and written by Kibana background
 * tasks running as `kibana_system`. That reserved service account has
 * full access to `.kibana_*` indices but NOT to custom indices outside
 * that prefix. Putting scheduled jobs in a SavedObject means we don't
 * need operators to configure custom role mappings just to make the
 * scheduler work.
 *
 * Other deepfreeze doctypes (repository, thaw_request, audit_entry)
 * stay in their respective indices because they have a different
 * access pattern — they're touched by route handlers running as the
 * requesting user (`asCurrentUser`), and Python parity is meaningful
 * there.
 *
 * The SO `id` is the user-facing job name. The legacy ES schema had
 * `name` as a top-level attribute; here it's implicit in the id so
 * lookups by name become trivial.
 */

import type { CoreSetup } from '@kbn/core/server';

export const SCHEDULED_JOB_SO_TYPE = 'deepfreeze-scheduled-job';

/**
 * SO attributes — everything from the legacy `ScheduledJobDoc` shape
 * EXCEPT `doctype` (implicit in the SO type) and `name` (implicit in
 * the SO id).
 */
export interface ScheduledJobSoAttributes {
  action: string;
  params: Record<string, unknown>;
  cron: string | null;
  interval_seconds: number | null;
  paused: boolean;
  created_at: string;
}

/**
 * Register the SO type with Kibana. Must run during plugin.setup so
 * the type is known by the time plugin.start tries to create/read SOs.
 */
export function registerScheduledJobSavedObject(core: CoreSetup): void {
  core.savedObjects.registerType<ScheduledJobSoAttributes>({
    name: SCHEDULED_JOB_SO_TYPE,
    // hidden:true keeps the docs out of the generic Saved Objects
    // management UI. Our own Schedules tab is the canonical surface;
    // operators editing scheduled_job docs through Kibana's SO UI
    // would bypass our audit + TaskManager sync, which is bad.
    hidden: true,
    // Scheduled jobs are cluster-global — they fire regardless of
    // which space the operator is currently in.
    namespaceType: 'agnostic',
    mappings: {
      properties: {
        action: { type: 'keyword' },
        // params is an opaque per-action bag; `flattened` keeps the
        // mapping cardinality bounded.
        params: { type: 'flattened' },
        cron: { type: 'keyword' },
        interval_seconds: { type: 'integer' },
        paused: { type: 'boolean' },
        created_at: { type: 'date' },
      },
    },
  });
}
