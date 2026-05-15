/**
 * Background job lifecycle types.
 *
 * Mirrors:
 *   packages/deepfreeze-server/deepfreeze_server/models/jobs.py
 *
 * In the Python server, `Job` is held in memory by `JobManager`. In the
 * Kibana plugin the equivalent state lives in a TaskManager task instance
 * plus a status saved object that the UI polls — but the wire shape
 * returned by `/api/deepfreeze/jobs` keeps the same fields so UI code
 * ports without changes.
 */

import type { CommandResult } from './commands';
import type { ServiceError } from './errors';

export const JOB_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface JobProgress {
  percent: number;
  message: string;
  steps: string[];
}

export interface Job {
  id: string;
  /** Action name: rotate, thaw, cleanup, etc. */
  type: string;
  status: JobStatus;
  params: Record<string, unknown>;
  submitted_at: string;
  started_at: string | null;
  completed_at: string | null;
  progress: JobProgress;
  result: CommandResult | null;
  error: ServiceError | null;
  submitted_by: string;
}

/** Response returned when a job is submitted (HTTP 202). */
export interface JobSubmission {
  job_id: string;
  status: JobStatus;
}
