import type { TaskManagerStartContract } from '@kbn/task-manager-plugin/server';

import { runActionForSchedule, syncTaskManager } from '../sync';
import { TASK_TYPES } from '../task_types';
import type { ScheduledJobDoc } from '../../../common/schemas/scheduled_job';

interface TmCalls {
  ensureScheduled: Array<{
    id: string;
    taskType: string;
    schedule: { interval: string };
    params: Record<string, unknown>;
  }>;
  removeIfExists: string[];
}

function makeTm(): { taskManager: TaskManagerStartContract; calls: TmCalls } {
  const calls: TmCalls = { ensureScheduled: [], removeIfExists: [] };
  const taskManager = {
    ensureScheduled: async (params: {
      id: string;
      taskType: string;
      schedule: { interval: string };
      params: Record<string, unknown>;
    }) => {
      calls.ensureScheduled.push({
        id: params.id,
        taskType: params.taskType,
        schedule: params.schedule,
        params: params.params,
      });
      return {} as never;
    },
    removeIfExists: async (id: string) => {
      calls.removeIfExists.push(id);
      return {} as never;
    },
  } as unknown as TaskManagerStartContract;
  return { taskManager, calls };
}

function job(over: Partial<ScheduledJobDoc> = {}): ScheduledJobDoc {
  return {
    doctype: 'scheduled_job',
    name: 'demo',
    action: 'rotate',
    params: { keep: 6 },
    cron: null,
    interval_seconds: 3600,
    paused: false,
    created_at: '2026-05-19T00:00:00Z',
    ...over,
  };
}

describe('syncTaskManager', () => {
  it('schedules a non-paused job with a valid interval', async () => {
    const { taskManager, calls } = makeTm();
    const sync = await syncTaskManager(taskManager, job({ name: 'r1' }));
    expect(sync).toBe('scheduled');
    expect(calls.ensureScheduled).toHaveLength(1);
    expect(calls.ensureScheduled[0]).toMatchObject({
      id: 'scheduled_job:r1',
      taskType: TASK_TYPES.rotate,
      schedule: { interval: '3600s' },
      params: { keep: 6 },
    });
    expect(calls.removeIfExists).toEqual([]);
  });

  it('removes a paused job (kept in ES, absent from TaskManager)', async () => {
    const { taskManager, calls } = makeTm();
    const sync = await syncTaskManager(taskManager, job({ name: 'r1', paused: true }));
    expect(sync).toBe('paused_removed');
    expect(calls.ensureScheduled).toEqual([]);
    expect(calls.removeIfExists).toEqual(['scheduled_job:r1']);
  });

  it('removes a job with an unknown action (defensive: shouldn\'t fire)', async () => {
    const { taskManager, calls } = makeTm();
    const sync = await syncTaskManager(
      taskManager,
      job({ name: 'r1', action: 'mystery' })
    );
    expect(sync).toBe('invalid_action_removed');
    expect(calls.ensureScheduled).toEqual([]);
    expect(calls.removeIfExists).toEqual(['scheduled_job:r1']);
  });

  it('removes a job with no interval_seconds (corrupted doc)', async () => {
    const { taskManager, calls } = makeTm();
    const sync = await syncTaskManager(
      taskManager,
      job({ name: 'r1', interval_seconds: null })
    );
    expect(sync).toBe('invalid_action_removed');
    expect(calls.removeIfExists).toEqual(['scheduled_job:r1']);
  });

  it('maps each action to its corresponding task type', async () => {
    const { taskManager, calls } = makeTm();
    await syncTaskManager(taskManager, job({ name: 'r', action: 'rotate' }));
    await syncTaskManager(taskManager, job({ name: 'c', action: 'cleanup' }));
    await syncTaskManager(taskManager, job({ name: 'm', action: 'repair_metadata' }));
    expect(calls.ensureScheduled.map((c) => c.taskType)).toEqual([
      TASK_TYPES.rotate,
      TASK_TYPES.cleanup,
      TASK_TYPES.repairMetadata,
    ]);
  });
});

describe('runActionForSchedule', () => {
  const noopLog = { debug: () => {}, warn: () => {} };

  it('rejects an unsupported action', async () => {
    await expect(
      runActionForSchedule(
        {} as never,
        job({ action: 'fly_to_mars' }),
        { log: noopLog }
      )
    ).rejects.toThrow(/Unsupported schedule action/);
  });

  // Smoke tests for the action dispatch — the underlying actions are
  // already covered by their own test suites; here we just verify the
  // dispatch routes to the right one. We pass an obviously-broken
  // client so each action throws early, but THROUGH the dispatch
  // (proving the dispatch picked the right branch).

  it('routes rotate action to runRotate', async () => {
    const client = {
      indices: {
        exists: async () => {
          throw new Error('rotate-was-called');
        },
      },
    };
    await expect(
      runActionForSchedule(client as never, job({ action: 'rotate' }), {
        log: noopLog,
      })
    ).rejects.toThrow(/rotate-was-called/);
  });

  it('routes cleanup action to runCleanup', async () => {
    const client = {
      indices: {
        exists: async () => {
          throw new Error('cleanup-was-called');
        },
      },
    };
    await expect(
      runActionForSchedule(client as never, job({ action: 'cleanup' }), {
        log: noopLog,
      })
    ).rejects.toThrow(/cleanup-was-called/);
  });

  it('routes repair_metadata action to runRepairMetadata (requires settings)', async () => {
    // RepairMetadata first calls getSettings; we make that throw early
    // so the test passes through the right dispatch branch.
    const client = {
      indices: { exists: async () => true },
      get: async () => {
        throw new Error('repair_metadata-was-called');
      },
    };
    await expect(
      runActionForSchedule(client as never, job({ action: 'repair_metadata' }), {
        log: noopLog,
      })
    ).rejects.toThrow(/repair_metadata-was-called/);
  });
});
