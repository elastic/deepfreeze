/**
 * Hook for fetching system status from the API.
 * Auto-refresh is handled by RefreshControl at the page level.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, type SystemStatus } from '../api/client';

export function useStatus() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (force = false) => {
    try {
      setLoading(true);
      const data = await api.getStatus(force);
      setStatus(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch only
  useEffect(() => {
    refresh();
  }, [refresh]);

  return { status, loading, error, refresh };
}
