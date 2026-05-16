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

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const e = err as { statusCode?: number; meta?: { statusCode?: number } };
  return e.statusCode === 404 || e.meta?.statusCode === 404;
}
