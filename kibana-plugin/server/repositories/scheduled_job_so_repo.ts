/**
 * Scheduled-job repository backed by Kibana SavedObjects.
 *
 * Replaces the original `deepfreeze-status`-backed implementation —
 * SavedObjects live in `.kibana_*` indices that `kibana_system` has
 * full access to, so the bootstrap and task runners work without
 * custom role mappings.
 *
 * The SO type and attributes shape are defined in
 *   server/saved_objects/scheduled_job_type.ts
 * The SO id IS the user-facing job name. Route + UI callers continue
 * to think in terms of `ScheduledJobDoc`; this module bridges the two
 * shapes via `soToDoc` / `docToAttributes`.
 */

import type { ScheduledJobDoc } from '../../common/schemas/scheduled_job';
import {
  SCHEDULED_JOB_SO_TYPE,
  type ScheduledJobSoAttributes,
} from '../saved_objects/scheduled_job_type';

/**
 * Minimal structural interface satisfied by both
 *   - `SavedObjectsClientContract` (request-scoped, per-user)
 *   - `ISavedObjectsRepository` (internal, bypasses user privileges)
 *
 * Captures only the methods we actually call. Lets test fakes stay
 * narrow and keeps the rest of this file from worrying about the
 * (slightly different) full SO API surface.
 */
export interface ScheduledJobSoClient {
  find: <T>(options: {
    type: string;
    perPage?: number;
    sortField?: string;
    sortOrder?: 'asc' | 'desc';
  }) => Promise<{
    saved_objects: Array<{ id: string; type: string; attributes: T }>;
    total: number;
  }>;
  get: <T>(
    type: string,
    id: string
  ) => Promise<{ id: string; type: string; attributes: T }>;
  create: <T>(
    type: string,
    attributes: T,
    options?: { id?: string; overwrite?: boolean }
  ) => Promise<{ id: string; type: string; attributes: T }>;
  update: <T>(
    type: string,
    id: string,
    attributes: Partial<T>
  ) => Promise<{ id: string; type: string; attributes: Partial<T> }>;
  delete: (type: string, id: string) => Promise<unknown>;
}

/** Reconstruct the wire shape `ScheduledJobDoc` from a SO. */
function soToDoc(
  so: { id: string; attributes: ScheduledJobSoAttributes }
): ScheduledJobDoc {
  return {
    doctype: 'scheduled_job',
    name: so.id,
    action: so.attributes.action,
    params: so.attributes.params,
    cron: so.attributes.cron,
    interval_seconds: so.attributes.interval_seconds,
    paused: so.attributes.paused,
    created_at: so.attributes.created_at,
  };
}

/** Strip the doctype/name (implicit in type/id) from a doc. */
function docToAttributes(doc: ScheduledJobDoc): ScheduledJobSoAttributes {
  return {
    action: doc.action,
    params: doc.params,
    cron: doc.cron,
    interval_seconds: doc.interval_seconds,
    paused: doc.paused,
    created_at: doc.created_at,
  };
}

/** Return every scheduled-job SO, sorted by name (= SO id) ascending. */
export async function getAllScheduledJobs(
  client: ScheduledJobSoClient
): Promise<ScheduledJobDoc[]> {
  const resp = await client.find<ScheduledJobSoAttributes>({
    type: SCHEDULED_JOB_SO_TYPE,
    perPage: 10000,
  });
  return resp.saved_objects.map(soToDoc).sort((a, b) => a.name.localeCompare(b.name));
}

/** Fetch a single job by name. Returns null on 404, throws otherwise. */
export async function getScheduledJob(
  client: ScheduledJobSoClient,
  name: string
): Promise<ScheduledJobDoc | null> {
  try {
    const so = await client.get<ScheduledJobSoAttributes>(SCHEDULED_JOB_SO_TYPE, name);
    return soToDoc(so);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * Upsert a job by name. Uses `overwrite: true` so create + update map
 * onto the same call, matching the original ES-`index`-based repo's
 * upsert semantics.
 */
export async function saveScheduledJob(
  client: ScheduledJobSoClient,
  job: ScheduledJobDoc
): Promise<void> {
  await client.create<ScheduledJobSoAttributes>(
    SCHEDULED_JOB_SO_TYPE,
    docToAttributes(job),
    { id: job.name, overwrite: true }
  );
}

/** Delete a job by name. 404 is a no-op (idempotent). */
export async function deleteScheduledJob(
  client: ScheduledJobSoClient,
  name: string
): Promise<void> {
  try {
    await client.delete(SCHEDULED_JOB_SO_TYPE, name);
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }
}

/**
 * Detect a 404 from either an `ISavedObjectsRepository` (throws
 * Boom-shaped errors with `output.statusCode`) or a raw ES error
 * (throws with `statusCode` at the top level). Duck-typed so the
 * test fakes don't need to import Kibana's error helpers.
 */
function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    isBoom?: boolean;
    output?: { statusCode?: number };
    statusCode?: number;
    meta?: { statusCode?: number };
  };
  return (
    e.output?.statusCode === 404 ||
    e.statusCode === 404 ||
    e.meta?.statusCode === 404
  );
}
