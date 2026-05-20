import { useCallback, useEffect, useState } from 'react';
import type { CoreStart } from '@kbn/core/public';

import { API } from '../../common/api/paths';
import type { ScheduledJobDoc } from '../../common/schemas/scheduled_job';

/**
 * Fetches `GET /api/deepfreeze/schedules` into local state and exposes
 * mutators that map onto the corresponding CRUD endpoints. Each
 * mutator refreshes the list on completion so the UI stays consistent
 * without optimistic-update bookkeeping.
 *
 * Errors surface as the returned `error` string (set on the list
 * fetch) or via thrown promises from mutators (consumed by toasts in
 * the caller).
 */
export function useSchedules(http: CoreStart['http']) {
  const [schedules, setSchedules] = useState<ScheduledJobDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      const data = await http.get<{ schedules: ScheduledJobDoc[] }>(API.schedules);
      setSchedules(data.schedules);
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

  const createSchedule = useCallback(
    async (body: {
      name: string;
      action: 'rotate' | 'cleanup' | 'repair_metadata' | 'update_date_ranges';
      params?: Record<string, unknown>;
      interval_seconds: number;
      paused?: boolean;
    }) => {
      const result = await http.post<ScheduledJobDoc>(API.schedules, {
        body: JSON.stringify(body),
      });
      await refresh();
      return result;
    },
    [http, refresh]
  );

  const updateSchedule = useCallback(
    async (
      name: string,
      patch: {
        action?: 'rotate' | 'cleanup' | 'repair_metadata' | 'update_date_ranges';
        params?: Record<string, unknown>;
        interval_seconds?: number;
        paused?: boolean;
      }
    ) => {
      const result = await http.put<ScheduledJobDoc>(API.schedule(name), {
        body: JSON.stringify(patch),
      });
      await refresh();
      return result;
    },
    [http, refresh]
  );

  const deleteSchedule = useCallback(
    async (name: string) => {
      await http.delete(API.schedule(name));
      await refresh();
    },
    [http, refresh]
  );

  const pauseSchedule = useCallback(
    async (name: string) => {
      const result = await http.post<ScheduledJobDoc>(API.schedulePause(name));
      await refresh();
      return result;
    },
    [http, refresh]
  );

  const resumeSchedule = useCallback(
    async (name: string) => {
      const result = await http.post<ScheduledJobDoc>(API.scheduleResume(name));
      await refresh();
      return result;
    },
    [http, refresh]
  );

  const runScheduleNow = useCallback(
    async (name: string) => {
      const result = await http.post<unknown>(API.scheduleRunNow(name));
      await refresh();
      return result;
    },
    [http, refresh]
  );

  return {
    schedules,
    loading,
    error,
    refresh,
    createSchedule,
    updateSchedule,
    deleteSchedule,
    pauseSchedule,
    resumeSchedule,
    runScheduleNow,
  };
}
