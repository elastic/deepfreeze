import type { Logger } from '@kbn/core/server';

import {
  legacyScheduledJobDocId,
  migrateScheduledJobs,
  type MigrationEsClient,
} from '../migration';
import type { ScheduledJobSoClient } from '../../repositories/scheduled_job_so_repo';
import type { ScheduledJobDoc } from '../../../common/schemas/scheduled_job';

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

function legacyDoc(over: Partial<ScheduledJobDoc> = {}): ScheduledJobDoc {
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

interface FakeOpts {
  /** Legacy docs in the deepfreeze-status index, keyed by name. */
  legacyJobs?: ScheduledJobDoc[];
  /** Force the search call to throw with this statusCode. */
  searchThrowsStatus?: number;
  /** Doc names whose SO create should throw. */
  failCreateNames?: string[];
  /** Doc names whose ES delete should throw. */
  failDeleteNames?: string[];
}

interface Trace {
  es_deletes: string[];
  so_creates: Array<{ id?: string; attributes: Record<string, unknown> }>;
}

function makeFakes(opts: FakeOpts = {}): {
  esClient: MigrationEsClient;
  soClient: ScheduledJobSoClient;
  trace: Trace;
} {
  const trace: Trace = { es_deletes: [], so_creates: [] };

  const esClient: MigrationEsClient = {
    search: async () => {
      if (opts.searchThrowsStatus !== undefined) {
        const err = new Error('boom') as Error & {
          statusCode?: number;
          meta?: { statusCode?: number };
        };
        err.statusCode = opts.searchThrowsStatus;
        err.meta = { statusCode: opts.searchThrowsStatus };
        throw err;
      }
      const jobs = opts.legacyJobs ?? [];
      return {
        hits: {
          hits: jobs.map((j) => ({
            _id: legacyScheduledJobDocId(j.name),
            _source: j as unknown as Record<string, unknown>,
          })),
        },
      };
    },
    delete: async ({ id }) => {
      const name = id.replace(/^scheduled_job:/, '');
      if (opts.failDeleteNames?.includes(name)) {
        throw new Error(`boom-delete-${name}`);
      }
      trace.es_deletes.push(id);
      return {};
    },
  };

  const soClient: ScheduledJobSoClient = {
    find: async () => ({ saved_objects: [], total: 0 }),
    get: async () => {
      throw new Error('not used');
    },
    create: async (type, attributes, options) => {
      const id = options?.id ?? 'generated';
      if (opts.failCreateNames?.includes(id)) {
        throw new Error(`boom-create-${id}`);
      }
      trace.so_creates.push({ id, attributes: attributes as Record<string, unknown> });
      return { id, type, attributes };
    },
    update: async () => {
      throw new Error('not used');
    },
    delete: async () => {
      throw new Error('not used');
    },
  };

  return { esClient, soClient, trace };
}

describe('migrateScheduledJobs', () => {
  it('migrates each legacy doc to a SavedObject and deletes the original', async () => {
    const { esClient, soClient, trace } = makeFakes({
      legacyJobs: [
        legacyDoc({ name: 'r1', action: 'rotate' }),
        legacyDoc({ name: 'r2', action: 'cleanup' }),
      ],
    });

    const result = await migrateScheduledJobs({
      esClient,
      soClient,
      logger: makeLogger(),
    });

    expect(result.migrated.sort()).toEqual(['r1', 'r2']);
    expect(result.failed).toEqual([]);
    expect(trace.so_creates.map((c) => c.id).sort()).toEqual(['r1', 'r2']);
    expect(trace.es_deletes.sort()).toEqual([
      'scheduled_job:r1',
      'scheduled_job:r2',
    ]);
  });

  it('treats a missing status index as nothing to migrate (fresh install)', async () => {
    const { esClient, soClient } = makeFakes({ searchThrowsStatus: 404 });
    const result = await migrateScheduledJobs({
      esClient,
      soClient,
      logger: makeLogger(),
    });
    expect(result.migrated).toEqual([]);
    expect(result.legacy_index_missing).toBe(true);
  });

  it('records SO-create failures and DOES NOT delete the legacy doc', async () => {
    // Critical correctness invariant: if the SO write fails, the
    // legacy doc must remain so re-running migration eventually
    // succeeds. Deleting the legacy doc after a failed SO write
    // would orphan the data.
    const { esClient, soClient, trace } = makeFakes({
      legacyJobs: [legacyDoc({ name: 'good' }), legacyDoc({ name: 'bad' })],
      failCreateNames: ['bad'],
    });

    const result = await migrateScheduledJobs({
      esClient,
      soClient,
      logger: makeLogger(),
    });

    expect(result.migrated).toEqual(['good']);
    expect(result.failed).toEqual([
      { name: 'bad', error: 'boom-create-bad' },
    ]);
    // ES delete only for the successful one.
    expect(trace.es_deletes).toEqual(['scheduled_job:good']);
  });

  it('skips legacy docs missing the name field', async () => {
    const { esClient, soClient, trace } = makeFakes();
    // Inject a malformed legacy doc.
    esClient.search = async () => ({
      hits: {
        hits: [
          {
            _id: 'scheduled_job:malformed',
            _source: { doctype: 'scheduled_job' /* no name */ },
          },
        ],
      },
    });

    const result = await migrateScheduledJobs({
      esClient,
      soClient,
      logger: makeLogger(),
    });

    expect(result.migrated).toEqual([]);
    expect(result.failed[0].name).toBe('scheduled_job:malformed');
    expect(trace.so_creates).toEqual([]);
    expect(trace.es_deletes).toEqual([]);
  });

  it('records ES-delete failures separately from SO-create failures', async () => {
    // SO create succeeds but ES delete fails. The job WAS migrated
    // (the SO exists), but the legacy doc lingers — re-running
    // migration will idempotently re-upsert the SO and try the
    // delete again.
    const { esClient, soClient, trace } = makeFakes({
      legacyJobs: [legacyDoc({ name: 'stuck' })],
      failDeleteNames: ['stuck'],
    });

    const result = await migrateScheduledJobs({
      esClient,
      soClient,
      logger: makeLogger(),
    });

    expect(result.migrated).toEqual([]); // delete failed → not counted
    expect(result.failed[0].name).toBe('stuck');
    expect(trace.so_creates.map((c) => c.id)).toEqual(['stuck']);
    expect(trace.es_deletes).toEqual([]);
  });
});
