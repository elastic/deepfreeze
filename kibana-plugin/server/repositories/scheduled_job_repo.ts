/**
 * Scheduled-job document access for the `deepfreeze-status` index.
 *
 * Mirrors the persistence layer of `DeepfreezeScheduler` in
 *   packages/deepfreeze-server/deepfreeze_server/orchestration/scheduler.py
 *     — _persist_job / _load_persisted_jobs / _delete_persisted_job
 *
 * Each scheduled-job doc lives at id `scheduled_job:<name>` in the
 * `deepfreeze-status` index with `doctype: 'scheduled_job'`. The name
 * is unique per cluster.
 */

import {
  DOCTYPE,
  SCHEDULED_JOB_ID_PREFIX,
  STATUS_INDEX,
} from '../../common/constants';
import type { ScheduledJobDoc } from '../../common/schemas/scheduled_job';

/**
 * Read surface. Mirrors the other repo client interfaces — narrow
 * structural type, no dep on @elastic/elasticsearch types.
 */
export interface ScheduledJobRepoEsClient {
  search: (params: {
    index: string;
    query?: Record<string, unknown>;
    size?: number;
  }) => Promise<{
    hits: {
      hits: Array<{ _id: string; _source: Record<string, unknown> }>;
    };
  }>;
}

/** Add write methods for create/update/delete. */
export interface ScheduledJobRepoWriteEsClient extends ScheduledJobRepoEsClient {
  index: (params: {
    index: string;
    id: string;
    document: Record<string, unknown>;
    refresh?: 'wait_for' | 'true' | 'false' | boolean;
  }) => Promise<unknown>;
  delete: (params: {
    index: string;
    id: string;
    refresh?: 'wait_for' | 'true' | 'false' | boolean;
  }) => Promise<unknown>;
}

/** Build the ES document ID from the user-facing job name. */
export function scheduledJobDocId(name: string): string {
  return `${SCHEDULED_JOB_ID_PREFIX}${name}`;
}

/**
 * Return every scheduled-job document in the status index, in stable
 * `name`-asc order. A missing or empty index returns `[]`.
 */
export async function getAllScheduledJobs(
  client: ScheduledJobRepoEsClient
): Promise<ScheduledJobDoc[]> {
  try {
    const response = await client.search({
      index: STATUS_INDEX,
      query: { term: { doctype: DOCTYPE.scheduled_job } },
      size: 10000,
    });
    const jobs = response.hits.hits.map(
      (hit) => hit._source as unknown as ScheduledJobDoc
    );
    return jobs.sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
}

/**
 * Fetch a single job by `name` (NOT by doc id). Returns `null` if
 * absent. Other errors propagate.
 *
 * The `name` field is mapped as `text` with a `.keyword` subfield in
 * the status-index mapping; we query the keyword subfield because the
 * analyzed text field tokenizes values like `"test-rotate"` and a
 * raw `term` query would never match.
 */
export async function getScheduledJob(
  client: ScheduledJobRepoEsClient,
  name: string
): Promise<ScheduledJobDoc | null> {
  try {
    const response = await client.search({
      index: STATUS_INDEX,
      query: {
        bool: {
          must: [
            { term: { doctype: DOCTYPE.scheduled_job } },
            { term: { 'name.keyword': name } },
          ],
        },
      },
      size: 1,
    });
    const hit = response.hits.hits[0];
    if (!hit) return null;
    return hit._source as unknown as ScheduledJobDoc;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * Upsert a job. The doctype is forced regardless of input so the index
 * mapping discriminator stays correct.
 */
export async function saveScheduledJob(
  client: ScheduledJobRepoWriteEsClient,
  job: ScheduledJobDoc
): Promise<void> {
  await client.index({
    index: STATUS_INDEX,
    id: scheduledJobDocId(job.name),
    document: { ...job, doctype: 'scheduled_job' },
    refresh: 'wait_for',
  });
}

/**
 * Delete a job by name. 404 is treated as a no-op (idempotent), like
 * the other repos in this package.
 */
export async function deleteScheduledJob(
  client: ScheduledJobRepoWriteEsClient,
  name: string
): Promise<void> {
  try {
    await client.delete({
      index: STATUS_INDEX,
      id: scheduledJobDocId(name),
      refresh: 'wait_for',
    });
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { statusCode?: number; meta?: { statusCode?: number } };
  return e.statusCode === 404 || e.meta?.statusCode === 404;
}
