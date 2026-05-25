/**
 * Thaw-request document access.
 *
 * Mirrors `list_thaw_requests` in
 *   packages/deepfreeze-core/deepfreeze_core/utilities.py
 */

import { DOCTYPE, STATUS_INDEX } from '../../common/constants';
import type { ThawRequestDoc } from '../../common/schemas/thaw_request';
import { ActionError } from '../errors';

export interface ThawRequestRepoEsClient {
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

/** Write surface for Cleanup / Refreeze operations on thaw requests. */
export interface ThawRequestRepoWriteEsClient extends ThawRequestRepoEsClient {
  delete: (params: {
    index: string;
    id: string;
    refresh?: 'wait_for' | 'true' | 'false' | boolean;
  }) => Promise<unknown>;
  index: (params: {
    index: string;
    id: string;
    document: Record<string, unknown>;
    refresh?: 'wait_for' | 'true' | 'false' | boolean;
  }) => Promise<unknown>;
}

/**
 * List every thaw request stored in the `deepfreeze-status` index.
 *
 * If the index does not exist, Python's implementation returns `[]`
 * (treating a missing index as 'no requests yet'). We preserve that
 * behaviour here: any ES exception whose status is 404 swallows to `[]`.
 * Other errors propagate as `ActionError`.
 */
export async function listThawRequests(
  client: ThawRequestRepoEsClient
): Promise<ThawRequestDoc[]> {
  try {
    const response = await client.search({
      index: STATUS_INDEX,
      query: { term: { doctype: DOCTYPE.thaw_request } },
      size: 10000,
    });
    return response.hits.hits.map(
      (hit) => hit._source as unknown as ThawRequestDoc
    );
  } catch (err) {
    if (isNotFound(err)) {
      return [];
    }
    throw new ActionError(
      `Failed to list thaw requests: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * List thaw requests in the `in_progress` state. Used by the
 * thaw-check TaskManager task to drive automatic restore-completion
 * polling without having to enumerate every historical request.
 *
 * Same 404-tolerance as `listThawRequests`: missing status index →
 * empty list. Other errors propagate.
 */
export async function listInProgressThawRequests(
  client: ThawRequestRepoEsClient
): Promise<ThawRequestDoc[]> {
  try {
    const response = await client.search({
      index: STATUS_INDEX,
      query: {
        bool: {
          must: [
            { term: { doctype: DOCTYPE.thaw_request } },
            { term: { status: 'in_progress' } },
          ],
        },
      },
      size: 10000,
    });
    return response.hits.hits.map(
      (hit) => hit._source as unknown as ThawRequestDoc
    );
  } catch (err) {
    if (isNotFound(err)) {
      return [];
    }
    throw new ActionError(
      `Failed to list in-progress thaw requests: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Fetch a single thaw request by its request_id. Returns `null` if
 * absent. Other errors propagate.
 */
export async function getThawRequest(
  client: ThawRequestRepoEsClient,
  request_id: string
): Promise<ThawRequestDoc | null> {
  const response = await client.search({
    index: STATUS_INDEX,
    query: { term: { request_id } },
    size: 1,
  });
  const hit = response.hits.hits[0];
  if (!hit) return null;
  return hit._source as unknown as ThawRequestDoc;
}

/**
 * Delete a thaw request doc by request_id (which is also the doc ID).
 * 404 is treated as no-op (idempotent).
 */
export async function deleteThawRequest(
  client: ThawRequestRepoWriteEsClient,
  request_id: string
): Promise<void> {
  try {
    await client.delete({ index: STATUS_INDEX, id: request_id, refresh: 'wait_for' });
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }
}

/**
 * Upsert a thaw request doc. Used by Refreeze to flip status from
 * `completed` to `refrozen`.
 */
export async function saveThawRequest(
  client: ThawRequestRepoWriteEsClient,
  request: ThawRequestDoc
): Promise<void> {
  await client.index({
    index: STATUS_INDEX,
    id: request.request_id,
    document: { ...request, doctype: 'thaw_request' },
    refresh: 'wait_for',
  });
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const e = err as { statusCode?: number; meta?: { statusCode?: number } };
  return e.statusCode === 404 || e.meta?.statusCode === 404;
}
