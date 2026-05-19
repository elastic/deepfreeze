import {
  deleteScheduledJob,
  getAllScheduledJobs,
  getScheduledJob,
  saveScheduledJob,
  scheduledJobDocId,
  type ScheduledJobRepoEsClient,
  type ScheduledJobRepoWriteEsClient,
} from '../scheduled_job_repo';
import {
  DOCTYPE,
  SCHEDULED_JOB_ID_PREFIX,
  STATUS_INDEX,
} from '../../../common/constants';
import type { ScheduledJobDoc } from '../../../common/schemas/scheduled_job';

function notFound(): Error {
  const e: Error & { statusCode?: number; meta?: { statusCode: number } } = new Error('nf');
  e.statusCode = 404;
  e.meta = { statusCode: 404 };
  return e;
}

function makeJob(over: Partial<ScheduledJobDoc> = {}): ScheduledJobDoc {
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

interface FakeOpts {
  jobs?: ScheduledJobDoc[];
  searchThrowStatus?: number;
  indexThrows?: boolean;
  deleteThrowStatus?: number;
}

interface Trace {
  index_calls: Array<{ index: string; id: string; document: Record<string, unknown> }>;
  delete_calls: Array<{ index: string; id: string }>;
}

function makeClient(opts: FakeOpts = {}): {
  client: ScheduledJobRepoWriteEsClient;
  trace: Trace;
} {
  const trace: Trace = { index_calls: [], delete_calls: [] };
  const client: ScheduledJobRepoWriteEsClient = {
    search: async (params) => {
      if (opts.searchThrowStatus !== undefined) {
        const err = new Error('boom') as Error & {
          statusCode?: number;
          meta?: { statusCode?: number };
        };
        err.statusCode = opts.searchThrowStatus;
        err.meta = { statusCode: opts.searchThrowStatus };
        throw err;
      }
      const query = (params.query ?? {}) as Record<string, unknown>;
      const jobs = opts.jobs ?? [];
      // `getScheduledJob` uses a bool/must with two term clauses
      // including the name (queried via the `.keyword` subfield —
      // the analyzed text field tokenizes hyphens). Filter on that.
      const bool = query.bool as { must?: Array<Record<string, unknown>> } | undefined;
      if (bool?.must) {
        const nameClause = bool.must.find(
          (c) => 'term' in c && (c.term as Record<string, unknown>)['name.keyword']
        );
        if (nameClause) {
          const name = (nameClause.term as { 'name.keyword': string })[
            'name.keyword'
          ];
          const j = jobs.find((j) => j.name === name);
          return {
            hits: {
              hits: j
                ? [
                    {
                      _id: scheduledJobDocId(j.name),
                      _source: j as unknown as Record<string, unknown>,
                    },
                  ]
                : [],
            },
          };
        }
      }
      // Default: list-all (term doctype only).
      return {
        hits: {
          hits: jobs.map((j) => ({
            _id: scheduledJobDocId(j.name),
            _source: j as unknown as Record<string, unknown>,
          })),
        },
      };
    },
    index: async (args) => {
      if (opts.indexThrows) throw new Error('boom-index');
      trace.index_calls.push(args);
      return {};
    },
    delete: async (args) => {
      if (opts.deleteThrowStatus !== undefined) {
        const err = new Error('boom') as Error & {
          statusCode?: number;
          meta?: { statusCode?: number };
        };
        err.statusCode = opts.deleteThrowStatus;
        err.meta = { statusCode: opts.deleteThrowStatus };
        throw err;
      }
      trace.delete_calls.push(args);
      return {};
    },
  };
  return { client, trace };
}

describe('scheduledJobDocId', () => {
  it('prefixes name with SCHEDULED_JOB_ID_PREFIX', () => {
    expect(scheduledJobDocId('nightly-rotate')).toBe(
      `${SCHEDULED_JOB_ID_PREFIX}nightly-rotate`
    );
  });
});

describe('getAllScheduledJobs', () => {
  it('returns docs sorted by name ascending', async () => {
    const { client } = makeClient({
      jobs: [
        makeJob({ name: 'zeta' }),
        makeJob({ name: 'alpha' }),
        makeJob({ name: 'middle' }),
      ],
    });
    const result = await getAllScheduledJobs(client);
    expect(result.map((j) => j.name)).toEqual(['alpha', 'middle', 'zeta']);
  });

  it('returns [] on a 404 (missing index)', async () => {
    const { client } = makeClient({ searchThrowStatus: 404 });
    await expect(getAllScheduledJobs(client)).resolves.toEqual([]);
  });

  it('propagates non-404 errors', async () => {
    const { client } = makeClient({ searchThrowStatus: 500 });
    await expect(getAllScheduledJobs(client)).rejects.toThrow();
  });
});

describe('getScheduledJob', () => {
  it('returns the doc when found by name', async () => {
    const job = makeJob({ name: 'nightly' });
    const { client } = makeClient({ jobs: [job] });
    const result = await getScheduledJob(client, 'nightly');
    expect(result).toEqual(job);
  });

  it('returns null when no job matches', async () => {
    const { client } = makeClient({ jobs: [makeJob({ name: 'other' })] });
    const result = await getScheduledJob(client, 'missing');
    expect(result).toBeNull();
  });

  it('returns null on 404 (idempotent read)', async () => {
    const { client } = makeClient({ searchThrowStatus: 404 });
    const result = await getScheduledJob(client, 'whatever');
    expect(result).toBeNull();
  });
});

describe('saveScheduledJob', () => {
  it('writes to status index with the prefixed doc id and forces doctype', async () => {
    const { client, trace } = makeClient();
    const job = makeJob({ name: 'rotate-daily' });
    await saveScheduledJob(client, job);
    expect(trace.index_calls).toHaveLength(1);
    const call = trace.index_calls[0];
    expect(call.index).toBe(STATUS_INDEX);
    expect(call.id).toBe(`${SCHEDULED_JOB_ID_PREFIX}rotate-daily`);
    expect(call.document.doctype).toBe('scheduled_job');
    expect(call.document.name).toBe('rotate-daily');
  });

  it('overrides doctype even if caller passes the wrong value', async () => {
    const { client, trace } = makeClient();
    // Caller might pass a malformed doc; the repo enforces the discriminator.
    const job = { ...makeJob(), doctype: 'wrong' as 'scheduled_job' };
    await saveScheduledJob(client, job);
    expect(trace.index_calls[0].document.doctype).toBe('scheduled_job');
  });
});

describe('deleteScheduledJob', () => {
  it('deletes by prefixed doc id', async () => {
    const { client, trace } = makeClient();
    await deleteScheduledJob(client, 'nightly-rotate');
    expect(trace.delete_calls).toEqual([
      {
        index: STATUS_INDEX,
        id: `${SCHEDULED_JOB_ID_PREFIX}nightly-rotate`,
        refresh: 'wait_for',
      },
    ]);
  });

  it('treats 404 as no-op (idempotent)', async () => {
    const { client } = makeClient({ deleteThrowStatus: 404 });
    await expect(deleteScheduledJob(client, 'missing')).resolves.toBeUndefined();
  });

  it('propagates non-404 delete errors', async () => {
    const { client } = makeClient({ deleteThrowStatus: 500 });
    await expect(deleteScheduledJob(client, 'whatever')).rejects.toThrow();
  });
});

describe('search query shape', () => {
  it('getAllScheduledJobs queries by doctype term and size=10000', async () => {
    let captured: Record<string, unknown> | null = null;
    const client: ScheduledJobRepoEsClient = {
      search: async (params) => {
        captured = params as unknown as Record<string, unknown>;
        return { hits: { hits: [] } };
      },
    };
    await getAllScheduledJobs(client);
    expect(captured).toMatchObject({
      index: STATUS_INDEX,
      query: { term: { doctype: DOCTYPE.scheduled_job } },
      size: 10000,
    });
  });
});
