import {
  deleteScheduledJob,
  getAllScheduledJobs,
  getScheduledJob,
  saveScheduledJob,
  type ScheduledJobSoClient,
} from '../scheduled_job_so_repo';
import type { ScheduledJobDoc } from '../../../common/schemas/scheduled_job';
import { SCHEDULED_JOB_SO_TYPE } from '../../saved_objects/scheduled_job_type';

/**
 * Generic SavedObject attributes pattern used by the SO API; the tests
 * only care about the action / paused / interval shape.
 */
type Attrs = Record<string, unknown>;

interface FakeOpts {
  /** Map of SO id → attributes. */
  store?: Record<string, Attrs>;
  findThrows?: boolean;
  getThrowsStatus?: number;
  deleteThrowsStatus?: number;
}

interface Trace {
  creates: Array<{
    type: string;
    id?: string;
    attributes: Attrs;
    overwrite?: boolean;
  }>;
  deletes: Array<{ type: string; id: string }>;
}

function notFound(status: number = 404): Error {
  const e: Error & {
    output?: { statusCode?: number };
    statusCode?: number;
  } = new Error('not found');
  e.output = { statusCode: status };
  e.statusCode = status;
  return e;
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

function makeClient(opts: FakeOpts = {}): {
  client: ScheduledJobSoClient;
  trace: Trace;
} {
  const trace: Trace = { creates: [], deletes: [] };
  const store: Record<string, Attrs> = { ...(opts.store ?? {}) };

  const client: ScheduledJobSoClient = {
    find: async (params) => {
      if (opts.findThrows) throw new Error('boom-find');
      const items = Object.entries(store);
      return {
        saved_objects: items.map(([id, attributes]) => ({
          id,
          type: params.type,
          attributes,
        })),
        total: items.length,
      };
    },
    get: async (type, id) => {
      if (opts.getThrowsStatus !== undefined) throw notFound(opts.getThrowsStatus);
      const attrs = store[id];
      if (!attrs) throw notFound();
      return { id, type, attributes: attrs };
    },
    create: async (type, attributes, options) => {
      trace.creates.push({
        type,
        id: options?.id,
        attributes: attributes as Attrs,
        overwrite: options?.overwrite,
      });
      const id = options?.id ?? 'generated';
      store[id] = attributes as Attrs;
      return { id, type, attributes };
    },
    update: async (type, id, attributes) => {
      store[id] = { ...store[id], ...(attributes as Attrs) };
      return { id, type, attributes };
    },
    delete: async (type, id) => {
      if (opts.deleteThrowsStatus !== undefined) throw notFound(opts.deleteThrowsStatus);
      trace.deletes.push({ type, id });
      delete store[id];
      return {};
    },
  };
  return { client, trace };
}

describe('getAllScheduledJobs', () => {
  it('returns docs sorted by name ascending', async () => {
    const { client } = makeClient({
      store: {
        zeta: {
          action: 'rotate',
          params: {},
          cron: null,
          interval_seconds: 60,
          paused: false,
          created_at: '2026-01-01T00:00:00Z',
        },
        alpha: {
          action: 'cleanup',
          params: {},
          cron: null,
          interval_seconds: 120,
          paused: false,
          created_at: '2026-01-01T00:00:00Z',
        },
        middle: {
          action: 'repair_metadata',
          params: {},
          cron: null,
          interval_seconds: 180,
          paused: false,
          created_at: '2026-01-01T00:00:00Z',
        },
      },
    });
    const result = await getAllScheduledJobs(client);
    expect(result.map((j) => j.name)).toEqual(['alpha', 'middle', 'zeta']);
  });

  it('round-trips the legacy ScheduledJobDoc shape', async () => {
    const { client } = makeClient({
      store: {
        nightly: {
          action: 'rotate',
          params: { keep: 7 },
          cron: null,
          interval_seconds: 86400,
          paused: true,
          created_at: '2026-05-19T00:00:00Z',
        },
      },
    });
    const result = await getAllScheduledJobs(client);
    expect(result[0]).toEqual({
      doctype: 'scheduled_job',
      name: 'nightly',
      action: 'rotate',
      params: { keep: 7 },
      cron: null,
      interval_seconds: 86400,
      paused: true,
      created_at: '2026-05-19T00:00:00Z',
    });
  });
});

describe('getScheduledJob', () => {
  it('returns the doc when found', async () => {
    const { client } = makeClient({
      store: {
        ny: {
          action: 'rotate',
          params: {},
          cron: null,
          interval_seconds: 60,
          paused: false,
          created_at: '2026-01-01T00:00:00Z',
        },
      },
    });
    const result = await getScheduledJob(client, 'ny');
    expect(result?.name).toBe('ny');
  });

  it('returns null on 404 (idempotent read)', async () => {
    const { client } = makeClient({ getThrowsStatus: 404 });
    await expect(getScheduledJob(client, 'missing')).resolves.toBeNull();
  });

  it('propagates non-404 errors', async () => {
    const { client } = makeClient({ getThrowsStatus: 500 });
    await expect(getScheduledJob(client, 'whatever')).rejects.toThrow();
  });
});

describe('saveScheduledJob', () => {
  it('upserts via create with overwrite:true and uses name as the SO id', async () => {
    const { client, trace } = makeClient();
    await saveScheduledJob(client, job({ name: 'r1' }));
    expect(trace.creates).toHaveLength(1);
    expect(trace.creates[0]).toMatchObject({
      type: SCHEDULED_JOB_SO_TYPE,
      id: 'r1',
      overwrite: true,
    });
    // Strips doctype + name from attributes (implicit in type/id).
    expect(trace.creates[0].attributes).not.toHaveProperty('doctype');
    expect(trace.creates[0].attributes).not.toHaveProperty('name');
    expect(trace.creates[0].attributes).toMatchObject({
      action: 'rotate',
      params: { keep: 6 },
    });
  });
});

describe('deleteScheduledJob', () => {
  it('deletes by name', async () => {
    const { client, trace } = makeClient({
      store: {
        bye: {
          action: 'rotate',
          params: {},
          cron: null,
          interval_seconds: 60,
          paused: false,
          created_at: '2026-01-01T00:00:00Z',
        },
      },
    });
    await deleteScheduledJob(client, 'bye');
    expect(trace.deletes).toEqual([{ type: SCHEDULED_JOB_SO_TYPE, id: 'bye' }]);
  });

  it('treats 404 as no-op (idempotent)', async () => {
    const { client } = makeClient({ deleteThrowsStatus: 404 });
    await expect(deleteScheduledJob(client, 'missing')).resolves.toBeUndefined();
  });

  it('propagates non-404 errors', async () => {
    const { client } = makeClient({ deleteThrowsStatus: 500 });
    await expect(deleteScheduledJob(client, 'x')).rejects.toThrow();
  });
});
