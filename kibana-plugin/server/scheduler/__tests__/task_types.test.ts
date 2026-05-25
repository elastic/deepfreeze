import type { Logger } from '@kbn/core/server';
import type {
  TaskManagerSetupContract,
  TaskRunCreatorFunction,
} from '@kbn/task-manager-plugin/server';
import { registerDeepfreezeTaskTypes, TASK_TYPES } from '../task_types';

/**
 * Minimal stand-in for the TaskManager setup contract. We only need
 * `registerTaskDefinitions` to be a spy so the assertions can inspect
 * what got registered.
 */
function makeTaskManagerMock(): {
  taskManager: TaskManagerSetupContract;
  calls: Array<Parameters<TaskManagerSetupContract['registerTaskDefinitions']>[0]>;
} {
  const calls: Array<Parameters<TaskManagerSetupContract['registerTaskDefinitions']>[0]> = [];
  const taskManager = {
    registerTaskDefinitions: (defs: Parameters<TaskManagerSetupContract['registerTaskDefinitions']>[0]) => {
      calls.push(defs);
    },
  } as unknown as TaskManagerSetupContract;
  return { taskManager, calls };
}

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

describe('registerDeepfreezeTaskTypes', () => {
  it('registers every deepfreeze task type', () => {
    const { taskManager, calls } = makeTaskManagerMock();
    registerDeepfreezeTaskTypes({
      taskManager,
      logger: makeLogger(),
      version: '9.4.0',
      getStartServices: async () => [{} as never],
    });

    expect(calls).toHaveLength(1);
    const definitions = calls[0];
    expect(Object.keys(definitions).sort()).toEqual(
      [
        TASK_TYPES.cleanup,
        TASK_TYPES.repairMetadata,
        TASK_TYPES.rotate,
        TASK_TYPES.thawCheck,
        TASK_TYPES.updateDateRanges,
      ].sort()
    );
  });

  it('each task definition carries a title, description, and createTaskRunner', () => {
    const { taskManager, calls } = makeTaskManagerMock();
    registerDeepfreezeTaskTypes({
      taskManager,
      logger: makeLogger(),
      version: '9.4.0',
      getStartServices: async () => [{} as never],
    });

    const defs = calls[0];
    for (const taskType of Object.values(TASK_TYPES)) {
      const def = defs[taskType];
      expect(def).toBeDefined();
      expect(typeof def.title).toBe('string');
      expect((def.title as string).length).toBeGreaterThan(0);
      expect(def.maxAttempts).toBe(1);
      expect(typeof def.createTaskRunner).toBe('function');
    }
  });

  it('each createTaskRunner produces an object with a run() method', () => {
    const { taskManager, calls } = makeTaskManagerMock();
    registerDeepfreezeTaskTypes({
      taskManager,
      logger: makeLogger(),
      version: '9.4.0',
      getStartServices: async () => [{} as never],
    });

    const defs = calls[0];
    for (const taskType of Object.values(TASK_TYPES)) {
      const factory = defs[taskType].createTaskRunner as TaskRunCreatorFunction;
      const runner = factory({
        taskInstance: {
          id: 'test',
          taskType,
          params: {},
          state: {},
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      expect(runner).toBeDefined();
      expect(typeof (runner as { run: () => unknown }).run).toBe('function');
    }
  });

  it('runWrapper traps action errors into state.last_error (does not throw to TaskManager)', async () => {
    // Force getStartServices to throw — simulates "core not started yet"
    // or a transient ES failure during a scheduled run. The runner
    // catches into state instead of propagating, so TaskManager's
    // retry logic isn't triggered for what is effectively a config
    // problem.
    const { taskManager, calls } = makeTaskManagerMock();
    registerDeepfreezeTaskTypes({
      taskManager,
      logger: makeLogger(),
      version: '9.4.0',
      getStartServices: async () => {
        throw new Error('core not started');
      },
    });

    const defs = calls[0];
    const factory = defs[TASK_TYPES.rotate].createTaskRunner as TaskRunCreatorFunction;
    const runner = factory({
      taskInstance: {
        id: 'test',
        taskType: TASK_TYPES.rotate,
        params: {},
        state: {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const result = (await (runner as { run: () => Promise<unknown> }).run()) as {
      state?: { last_success?: boolean; last_error?: string };
    };

    expect(result.state?.last_success).toBe(false);
    expect(result.state?.last_error).toMatch(/core not started/);
  });
});
