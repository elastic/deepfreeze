import { useCallback, useEffect, useRef, useState } from 'react';
import type { CoreStart } from '@kbn/core/public';

import { API } from '../../common/api/paths';
import type { ThawProgressResult } from '../../server/actions/thaw';

/**
 * Polling hook for `GET /api/deepfreeze/thaw-requests/{id}/progress`.
 *
 * - Polls every `intervalMs` (default 30s) while `enabled` and the
 *   request is still `in_progress`.
 * - Stops polling automatically once the server returns a terminal
 *   status (`completed` / `failed` / `refrozen`), so the UI doesn't
 *   keep hammering ES + S3 for a request that has settled.
 * - Pass `enabled: false` to halt polling (e.g. when the flyout closes).
 */
export function useThawProgress(
  http: CoreStart['http'],
  requestId: string | null,
  enabled: boolean,
  intervalMs: number = 30_000
) {
  const [progress, setProgress] = useState<ThawProgressResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchOnce = useCallback(async () => {
    if (!requestId) return null;
    setLoading(true);
    try {
      const data = await http.get<ThawProgressResult>(API.thawProgress(requestId));
      setProgress(data);
      setError(null);
      return data;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setError(msg);
      return null;
    } finally {
      setLoading(false);
    }
  }, [http, requestId]);

  useEffect(() => {
    if (!enabled || !requestId) return;

    let cancelled = false;
    const tick = async () => {
      const data = await fetchOnce();
      if (cancelled) return;
      // Terminal statuses stop the polling loop.
      if (
        data &&
        (data.status === 'completed' ||
          data.status === 'failed' ||
          data.status === 'refrozen')
      ) {
        return;
      }
      timerRef.current = setTimeout(tick, intervalMs);
    };

    tick();

    return () => {
      cancelled = true;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [enabled, requestId, intervalMs, fetchOnce]);

  return { progress, loading, error, refresh: fetchOnce };
}

/**
 * One-shot caller for `POST /api/deepfreeze/thaw-requests/{id}/check`.
 *
 * Decoupled from the polling hook so the UI can fire it explicitly
 * when the user clicks "Check now" — `/check` has side effects
 * (mount + status flip) that we don't want running on a timer.
 */
export async function postThawCheck(
  http: CoreStart['http'],
  requestId: string
): Promise<ThawProgressResult> {
  return http.post<ThawProgressResult>(API.thawCheck(requestId));
}
