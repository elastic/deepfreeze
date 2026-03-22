/**
 * Hook for polling system status from the API.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, type SystemStatus } from '../api/client';

export function useStatus(pollInterval = 30000) {
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

  useEffect(() => {
    refresh();
    if (pollInterval > 0) {
      const interval = setInterval(() => refresh(), pollInterval);
      return () => clearInterval(interval);
    }
  }, [refresh, pollInterval]);

  return { status, loading, error, refresh };
}
