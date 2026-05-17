import {
  runCleanup,
  runCleanupDryRun,
  type CleanupActionEsClient,
} from '../cleanup';
import { MissingSettingsError } from '../../errors';
import { SETTINGS_DEFAULTS, type SettingsDoc } from '../../../common/schemas/settings';
import { DOCTYPE, SETTINGS_ID, STATUS_INDEX } from '../../../common/constants';
import type { RepositoryDoc } from '../../../common/schemas/repository';
import type { ThawRequestDoc } from '../../../common/schemas/thaw_request';

interface FakeOpts {
  settings?: SettingsDoc | null;
  repos?: RepositoryDoc[];
  thawRequests?: ThawRequestDoc[];
  failDeleteIds?: string[];
}

interface Trace {
  deleted: string[];
  index_calls: Array<{ index: string; id: string; document: Record<string, unknown> }>;
  snapshot_deletes: string[];
}

function notFound(): Error {
  const e: Error & { statusCode?: number; meta?: { statusCode: number } } = new Error('nf');
  e.statusCode = 404;
  e.meta = { statusCode: 404 };
  return e;
}

function makeClient(opts: FakeOpts = {}): { client: CleanupActionEsClient; trace: Trace } {
  const trace: Trace = { deleted: [], index_calls: [], snapshot_deletes: [] };

  const client: CleanupActionEsClient = {
    indices: { exists: async () => true } as CleanupActionEsClient['indices'],
    get: async ({ id }) => {
      if (id === SETTINGS_ID) {
        if (opts.settings === null) return { found: false };
        return { _source: opts.settings ?? SETTINGS_DEFAULTS, found: true };
      }
      return { found: false };
    },
    search: async (params) => {
      const query = params.query as { match?: { doctype?: string }; term?: { doctype?: string } };
      const dt = query.match?.doctype ?? query.term?.doctype;
      if (dt === DOCTYPE.repository) {
        return {
          hits: {
            hits: (opts.repos ?? []).map((r) => ({
              _id: r.name,
              _source: r as unknown as Record<string, unknown>,
            })),
          },
        };
      }
      if (dt === DOCTYPE.thaw_request) {
        return {
          hits: {
            hits: (opts.thawRequests ?? []).map((t) => ({
              _id: t.request_id,
              _source: t as unknown as Record<string, unknown>,
            })),
          },
        };
      }
      return { hits: { hits: [] } };
    },
    index: async (args) => {
      trace.index_calls.push(args);
      return {};
    },
    delete: async ({ id }) => {
      if (opts.failDeleteIds?.includes(id)) throw new Error(`boom-${id}`);
      trace.deleted.push(id);
      return {};
    },
    snapshot: {
      getRepository: async () => ({}),
      createRepository: async () => ({}),
      deleteRepository: async ({ name }) => {
        trace.snapshot_deletes.push(name);
        return {};
      },
    },
    ilm: {
      getLifecycle: async () => ({}),
      putLifecycle: async () => ({}),
    },
  };

  return { client, trace };
}

function settings(overrides: Partial<SettingsDoc> = {}): SettingsDoc {
  return { ...SETTINGS_DEFAULTS, ...overrides };
}

function thawReq(id: string, status: ThawRequestDoc['status'], created_at: string): ThawRequestDoc {
  return {
    doctype: 'thaw_request',
    request_id: id,
    repos: ['deepfreeze-000001'],
    status,
    created_at,
  };
}

function repoDoc(name: string, overrides: Partial<RepositoryDoc> = {}): RepositoryDoc {
  return {
    doctype: 'repository',
    name,
    bucket: 'b',
    base_path: 'p',
    start: null,
    end: null,
    is_thawed: false,
    is_mounted: true,
    thaw_state: 'active',
    thawed_at: null,
    expires_at: null,
    ...overrides,
  };
}

const NOW = new Date('2026-05-17T00:00:00Z');
const nowFn = () => NOW;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400_000).toISOString();

// -- Preconditions ---------------------------------------------------------

describe('runCleanup preconditions', () => {
  it('throws MissingSettingsError when settings doc is absent', async () => {
    const { client } = makeClient({ settings: null });
    await expect(runCleanup(client)).rejects.toBeInstanceOf(MissingSettingsError);
  });
});

// -- Thaw-request retention -----------------------------------------------

describe('runCleanup thaw-request retention', () => {
  it('deletes requests past per-status retention windows', async () => {
    // SETTINGS_DEFAULTS: completed=7, failed=30, refrozen=35
    const { client, trace } = makeClient({
      settings: settings(),
      thawRequests: [
        thawReq('c-old', 'completed', daysAgo(8)),
        thawReq('c-young', 'completed', daysAgo(3)),
        thawReq('f-old', 'failed', daysAgo(31)),
        thawReq('f-young', 'failed', daysAgo(10)),
        thawReq('r-old', 'refrozen', daysAgo(40)),
        thawReq('r-young', 'refrozen', daysAgo(30)),
        // in_progress requests are never deleted by Cleanup
        thawReq('in-progress', 'in_progress', daysAgo(1000)),
      ],
    });

    const result = await runCleanup(client, {}, { now: nowFn });
    expect(result.success).toBe(true);
    expect(result.deleted_thaw_requests.sort()).toEqual(['c-old', 'f-old', 'r-old']);
    expect(trace.deleted.sort()).toEqual(['c-old', 'f-old', 'r-old']);
  });

  it('respects retention overrides on the call', async () => {
    const { client } = makeClient({
      settings: settings(),
      thawRequests: [
        thawReq('c-3d', 'completed', daysAgo(3)),
        thawReq('c-5d', 'completed', daysAgo(5)),
      ],
    });

    // Override completed retention to 1 day → both should be deleted.
    const result = await runCleanup(
      client,
      { retention_days_completed: 1 },
      { now: nowFn }
    );
    expect(result.deleted_thaw_requests.sort()).toEqual(['c-3d', 'c-5d']);
  });

  it('records per-document delete failures as warnings, continues with the rest', async () => {
    const { client } = makeClient({
      settings: settings(),
      thawRequests: [
        thawReq('a', 'completed', daysAgo(10)),
        thawReq('b', 'completed', daysAgo(10)),
      ],
      failDeleteIds: ['a'],
    });

    const result = await runCleanup(client, {}, { now: nowFn });
    expect(result.success).toBe(true);
    expect(result.deleted_thaw_requests).toEqual(['b']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].target).toBe('a');
  });
});

// -- Expired repos ---------------------------------------------------------

describe('runCleanup expired repos', () => {
  it('archives repos whose expires_at is in the past', async () => {
    const { client, trace } = makeClient({
      settings: settings(),
      repos: [
        repoDoc('expired-by-date', {
          thaw_state: 'thawed',
          is_thawed: true,
          thawed_at: daysAgo(5),
          expires_at: daysAgo(1),
        }),
        repoDoc('still-active', {
          thaw_state: 'thawed',
          is_thawed: true,
          expires_at: daysAgo(-3), // 3 days in future
        }),
      ],
    });

    const result = await runCleanup(client, {}, { now: nowFn });
    expect(result.expired_repositories).toEqual(['expired-by-date']);
    expect(trace.snapshot_deletes).toEqual(['expired-by-date']);

    const flippedDoc = trace.index_calls
      .map((c) => c.document as Record<string, unknown>)
      .find((d) => d.doctype === 'repository' && d.name === 'expired-by-date');
    expect(flippedDoc).toMatchObject({
      is_mounted: false,
      is_thawed: false,
      thaw_state: 'frozen',
      thawed_at: null,
      expires_at: null,
    });
  });

  it('also picks up repos already marked thaw_state=expired (no expires_at)', async () => {
    const { client } = makeClient({
      settings: settings(),
      repos: [repoDoc('flagged-expired', { thaw_state: 'expired' })],
    });

    const result = await runCleanup(client, {}, { now: nowFn });
    expect(result.expired_repositories).toEqual(['flagged-expired']);
  });
});

// -- Dry-run ---------------------------------------------------------------

describe('runCleanupDryRun', () => {
  it('reports would-delete and would-archive without mutating anything', async () => {
    const { client, trace } = makeClient({
      settings: settings(),
      thawRequests: [thawReq('a', 'completed', daysAgo(10))],
      repos: [repoDoc('exp', { thaw_state: 'expired' })],
    });

    const result = await runCleanupDryRun(client, {}, { now: nowFn });
    expect(result.dry_run).toBe(true);
    expect(result.deleted_thaw_requests).toEqual(['a']);
    expect(result.expired_repositories).toEqual(['exp']);
    expect(trace.deleted).toEqual([]);
    expect(trace.index_calls).toEqual([]);
    expect(trace.snapshot_deletes).toEqual([]);
  });
});
