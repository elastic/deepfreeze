import { useCallback, useEffect, useState } from 'react';
import type { CoreStart } from '@kbn/core/public';

import { API } from '../../common/api/paths';
import type { StatusResult } from '../../server/actions/status';

/**
 * Fetches GET /api/deepfreeze/status into local state.
 *
 * The Python frontend had its own caching layer at the FastAPI server;
 * the Kibana plugin pushes the cluster query directly to ES on each
 * call. That's cheap enough — repositories/thaw_requests live in a
 * single `deepfreeze-status` index — and lets the UI rely on a single
 * "refresh now" action without server-side cache invalidation.
 */
export function useStatus(http: CoreStart['http']) {
  const [status, setStatus] = useState<StatusResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      const data = await http.get<StatusResult>(API.status);
      setStatus(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [http]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { status, loading, error, refresh };
}
