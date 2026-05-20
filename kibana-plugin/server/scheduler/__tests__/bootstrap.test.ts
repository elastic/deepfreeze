import type { Logger } from '@kbn/core/server';
import type { TaskManagerStartContract } from '@kbn/task-manager-plugin/server';

import {
  bootstrapDeepfreezeSchedules,
  bootstrapTaskId,
  resolveTaskTypeForAction,
} from '../bootstrap';
import { TASK_TYPES } from '../task_types';
import type { ScheduledJobDoc } from '../../../common/schemas/scheduled_job';
import type { ScheduledJobSoClient } from '../../repositories/scheduled_job_so_repo';
import { SCHEDULED_JOB_SO_TYPE } from '../../saved_objects/scheduled_job_type';

function makeLogger(): Logger {
  const noop = () => {};
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    trace: noop,
    log: noop,
    isLevelEnabled: () => true,
    get: () => makeLogger(),
  } as unknown as Logger;
}

/**
 * Stand-in for a SavedObjects client / repository. We only implement
 * `find` because bootstrap is read-only against the SO layer.
 */
function makeRepoClient(jobs: ScheduledJobDoc[]): ScheduledJobSoClient {
  return {
    find: async () => ({
      saved_objects: jobs.map((j) => ({
        id: j.name,
        type: SCHEDULED_JOB_SO_TYPE,
        attributes: {
          action: j.action,
          params: j.params,
          cron: j.cron,
          interval_seconds: j.interval_seconds,
          paused: j.paused,
          created_at: j.created_at,
        },
      })),
      total: jobs.length,
    }),
    get: async () => {
      throw new Error('not implemented');
    },
    create: async () => {
      throw new Error('not implemented');
    },
    update: async () => {
      throw new Error('not implemented');
    },
    delete: async () => {
      throw new Error('not implemented');
    },
  };
}

interface TmCalls {
  ensureScheduled: Array<{
    id: string;
    taskType: string;
    schedule: { interval: string };
    params: Record<string, unknown>;
  }>;
  removeIfExists: string[];
  fetch: Array<Record<string, unknown>>;
}

/**
 * Optional existing-task seed for the orphan-sweep. Each entry is
 * what TaskManager.fetch() returns when the bootstrap enumerates
 * deepfreeze tasks at start. Only `id` and `taskType` matter for the
 * sweep logic; tests pass through additional fields when needed.
 */
interface SeedTask {
  id: string;
  taskType: string;
}

function makeTaskManager(seedTasks: SeedTask[] = []): {
  taskManager: TaskManagerStartContract;
  calls: TmCalls;
} {
  const calls: TmCalls = { ensureScheduled: [], removeIfExists: [], fetch: [] };
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
    fetch: async (opts: Record<string, unknown>) => {
      calls.fetch.push(opts);
      return {
        docs: seedTasks.map((t) => ({ id: t.id, taskType: t.taskType })),
        versionMap: new Map(),
      };
    },
  } as unknown as TaskManagerStartContract;
  return { taskManager, calls };
}

function job(over: Partial<ScheduledJobDoc> = {}): ScheduledJobDoc {
  return {
    doctype: 'scheduled_job',
    name: 'nightly-rotate',
    action: 'rotate',
    params: { keep: 6 },
    cron: null,
    interval_seconds: 86400,
    paused: false,
    created_at: '2026-05-19T00:00:00Z',
    ...over,
  };
}

describe('resolveTaskTypeForAction', () => {
  it.each([
    ['rotate', TASK_TYPES.rotate],
    ['cleanup', TASK_TYPES.cleanup],
    ['repair', TASK_TYPES.repairMetadata],
    ['repair_metadata', TASK_TYPES.repairMetadata],
    ['update_date_ranges', TASK_TYPES.updateDateRanges],
  ])('maps %s → %s', (action, expected) => {
    expect(resolveTaskTypeForAction(action)).toBe(expected);
  });

  it('returns null for unknown actions', () => {
    expect(resolveTaskTypeForAction('thaw_check')).toBeNull();
    expect(resolveTaskTypeForAction('xyz')).toBeNull();
  });
});

describe('bootstrapTaskId', () => {
  it('uses the same prefix as the ES doc id', () => {
    expect(bootstrapTaskId('nightly')).toBe('scheduled_job:nightly');
  });
});

describe('bootstrapDeepfreezeSchedules', () => {
  it('schedules active jobs via ensureScheduled', async () => {
    const { taskManager, calls } = makeTaskManager();
    const result = await bootstrapDeepfreezeSchedules({
      client: makeRepoClient([
        job({ name: 'daily-rotate', action: 'rotate', interval_seconds: 86400 }),
        job({ name: 'hourly-cleanup', action: 'cleanup', interval_seconds: 3600 }),
      ]),
      taskManager,
      logger: makeLogger(),
    });

    expect(result.scheduled.sort()).toEqual(['daily-rotate', 'hourly-cleanup']);
    expect(calls.ensureScheduled).toHaveLength(2);
    const daily = calls.ensureScheduled.find((c) => c.id.endsWith('daily-rotate'));
    expect(daily).toMatchObject({
      taskType: TASK_TYPES.rotate,
      schedule: { interval: '86400s' },
      params: { keep: 6 },
    });
    const hourly = calls.ensureScheduled.find((c) => c.id.endsWith('hourly-cleanup'));
    expect(hourly).toMatchObject({
      taskType: TASK_TYPES.cleanup,
      schedule: { interval: '3600s' },
    });
  });

  it('removes paused jobs from TaskManager but keeps them in the result', async () => {
    const { taskManager, calls } = makeTaskManager();
    const result = await bootstrapDeepfreezeSchedules({
      client: makeRepoClient([job({ name: 'sleepy', paused: true })]),
      taskManager,
      logger: makeLogger(),
    });

    expect(calls.ensureScheduled).toEqual([]);
    expect(calls.removeIfExists).toEqual(['scheduled_job:sleepy']);
    expect(result.paused).toEqual(['sleepy']);
  });

  it('skips cron-only jobs (interval-only is the canonical scheduler)', async () => {
    const { taskManager, calls } = makeTaskManager();
    const result = await bootstrapDeepfreezeSchedules({
      client: makeRepoClient([
        job({ name: 'cronny', cron: '0 0 * * *', interval_seconds: null }),
      ]),
      taskManager,
      logger: makeLogger(),
    });
    expect(calls.ensureScheduled).toEqual([]);
    // Defensive remove so a previously-mapped task doesn't keep firing
    expect(calls.removeIfExists).toEqual(['scheduled_job:cronny']);
    expect(result.skipped).toEqual([
      {
        name: 'cronny',
        reason: 'cron expressions not supported; use interval_seconds instead',
      },
    ]);
  });

  it('skips unknown actions with a clear reason', async () => {
    const { taskManager, calls } = makeTaskManager();
    const result = await bootstrapDeepfreezeSchedules({
      client: makeRepoClient([
        job({ name: 'mystery', action: 'fly_to_mars', interval_seconds: 60 }),
      ]),
      taskManager,
      logger: makeLogger(),
    });
    expect(calls.ensureScheduled).toEqual([]);
    expect(result.scheduled).toEqual([]);
    expect(result.skipped).toEqual([
      { name: 'mystery', reason: "unknown action 'fly_to_mars'" },
    ]);
  });

  it('skips jobs with no interval_seconds', async () => {
    const { taskManager, calls } = makeTaskManager();
    const result = await bootstrapDeepfreezeSchedules({
      client: makeRepoClient([job({ name: 'no-schedule', interval_seconds: null })]),
      taskManager,
      logger: makeLogger(),
    });
    expect(calls.ensureScheduled).toEqual([]);
    expect(result.skipped[0]).toMatchObject({
      name: 'no-schedule',
      reason: 'no interval_seconds set',
    });
  });

  it('records per-job ensureScheduled errors without aborting the rest', async () => {
    const calls: TmCalls = { ensureScheduled: [], removeIfExists: [] };
    let failNext = true;
    const taskManager = {
      ensureScheduled: async (params: {
        id: string;
        taskType: string;
        schedule: { interval: string };
        params: Record<string, unknown>;
      }) => {
        if (failNext) {
          failNext = false;
          throw new Error('boom');
        }
        calls.ensureScheduled.push({
          id: params.id,
          taskType: params.taskType,
          schedule: params.schedule,
          params: params.params,
        });
        return {} as never;
      },
      removeIfExists: async () => ({}),
    } as unknown as TaskManagerStartContract;

    const result = await bootstrapDeepfreezeSchedules({
      client: makeRepoClient([
        job({ name: 'first' }),
        job({ name: 'second' }),
      ]),
      taskManager,
      logger: makeLogger(),
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ name: 'first', error: 'boom' });
    expect(result.scheduled).toEqual(['second']);
  });

  it('empty status index → empty result, no TaskManager calls', async () => {
    const { taskManager, calls } = makeTaskManager();
    const result = await bootstrapDeepfreezeSchedules({
      client: makeRepoClient([]),
      taskManager,
      logger: makeLogger(),
    });
    expect(result).toEqual({
      scheduled: [],
      paused: [],
      skipped: [],
      errors: [],
      removed_orphans: [],
    });
    expect(calls.ensureScheduled).toEqual([]);
    expect(calls.removeIfExists).toEqual([]);
    // The orphan sweep always runs, even with zero SOs — it's the only
    // way to reap deepfreeze tasks left behind by a since-deleted job.
    expect(calls.fetch).toHaveLength(1);
  });
});

describe('bootstrapDeepfreezeSchedules — orphan sweep', () => {
  it('removes a deepfreeze task whose SO no longer exists', async () => {
    const { taskManager, calls } = makeTaskManager([
      { id: 'scheduled_job:ghost-rotate', taskType: TASK_TYPES.rotate },
    ]);
    const result = await bootstrapDeepfreezeSchedules({
      client: makeRepoClient([]),
      taskManager,
      logger: makeLogger(),
    });
    expect(result.removed_orphans).toEqual(['scheduled_job:ghost-rotate']);
    expect(calls.removeIfExists).toEqual(['scheduled_job:ghost-rotate']);
  });

  it('leaves tasks that match an existing SO alone', async () => {
    const { taskManager, calls } = makeTaskManager([
      { id: 'scheduled_job:keepme', taskType: TASK_TYPES.rotate },
    ]);
    const result = await bootstrapDeepfreezeSchedules({
      client: makeRepoClient([job({ name: 'keepme' })]),
      taskManager,
      logger: makeLogger(),
    });
    expect(result.removed_orphans).toEqual([]);
    // ensureScheduled fired for the live job; removeIfExists was NOT
    // called as part of the sweep (only paused/invalid jobs trigger
    // it via applyScheduledJob, and "keepme" is neither).
    expect(calls.removeIfExists).toEqual([]);
    expect(calls.ensureScheduled).toHaveLength(1);
  });

  it('only enumerates deepfreeze task types', async () => {
    const { taskManager, calls } = makeTaskManager();
    await bootstrapDeepfreezeSchedules({
      client: makeRepoClient([]),
      taskManager,
      logger: makeLogger(),
    });
    const opts = calls.fetch[0] as { query?: { terms?: Record<string, unknown> } };
    expect(opts.query?.terms).toEqual({
      'task.taskType': [
        TASK_TYPES.rotate,
        TASK_TYPES.cleanup,
        TASK_TYPES.repairMetadata,
        TASK_TYPES.updateDateRanges,
      ],
    });
  });

  it('keeps going when a single orphan removal fails', async () => {
    const calls: TmCalls = { ensureScheduled: [], removeIfExists: [], fetch: [] };
    const taskManager = {
      ensureScheduled: async () => ({} as never),
      removeIfExists: async (id: string) => {
        calls.removeIfExists.push(id);
        if (id === 'scheduled_job:angry') throw new Error('boom');
        return {} as never;
      },
      fetch: async () => ({
        docs: [
          { id: 'scheduled_job:angry', taskType: TASK_TYPES.rotate },
          { id: 'scheduled_job:meek', taskType: TASK_TYPES.cleanup },
        ],
        versionMap: new Map(),
      }),
    } as unknown as TaskManagerStartContract;

    const result = await bootstrapDeepfreezeSchedules({
      client: makeRepoClient([]),
      taskManager,
      logger: makeLogger(),
    });
    expect(result.removed_orphans).toEqual(['scheduled_job:meek']);
    expect(result.errors).toEqual([
      { name: 'scheduled_job:angry', error: 'boom' },
    ]);
  });

  it('logs and skips the sweep if fetch itself throws (bootstrap still succeeds)', async () => {
    const taskManager = {
      ensureScheduled: async () => ({} as never),
      removeIfExists: async () => ({} as never),
      fetch: async () => {
        throw new Error('task store unavailable');
      },
    } as unknown as TaskManagerStartContract;
    const result = await bootstrapDeepfreezeSchedules({
      client: makeRepoClient([job({ name: 'live' })]),
      taskManager,
      logger: makeLogger(),
    });
    expect(result.scheduled).toEqual(['live']);
    expect(result.removed_orphans).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});
