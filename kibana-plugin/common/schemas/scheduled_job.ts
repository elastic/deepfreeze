/**
 * Scheduled job document stored in the `deepfreeze-status` index.
 *
 * The document ID is `${SCHEDULED_JOB_ID_PREFIX}${name}` (e.g.
 * `scheduled_job:nightly-rotate`).
 *
 * Wire format (snake_case). Source-of-truth in Python:
 *   packages/deepfreeze-server/deepfreeze_server/orchestration/scheduler.py
 *   — Scheduler._persist_job()
 *
 * Exactly one of `cron` or `interval_seconds` is set on a valid job.
 * `params` is an opaque action-parameter bag; its shape depends on `action`.
 */
export interface ScheduledJobDoc {
  doctype: 'scheduled_job';
  name: string;
  action: string;
  params: Record<string, unknown>;
  cron: string | null;
  interval_seconds: number | null;
  paused: boolean;
  created_at: string;
}
