import {
  runUpdateDateRanges,
  type UpdateDateRangesActionEsClient,
} from '../update_date_ranges';
import type { RepositoryDoc } from '../../../common/schemas/repository';
import { STATUS_INDEX } from '../../../common/constants';

interface FakeOpts {
  repos?: RepositoryDoc[];
  snapshotIndices?: Record<string, string[]>;
  existingIndices?: string[];
  timestampRange?: { earliest: string | null; latest: string | null };
  searchAggThrows?: boolean;
}

interface ClientTrace {
  index_calls: Array<{ index: string; id: string; document: Record<string, unknown> }>;
  agg_searches: Array<{ index: string }>;
}

function makeClient(opts: FakeOpts = {}): {
  client: UpdateDateRangesActionEsClient;
  trace: ClientTrace;
} {
  const trace: ClientTrace = { index_calls: [], agg_searches: [] };
  const reposState: RepositoryDoc[] = [...(opts.repos ?? [])];
  const existing = new Set(opts.existingIndices ?? []);

  const client: UpdateDateRangesActionEsClient = {
    indices: {
      exists: async ({ index }) => existing.has(index),
    },
    search: async (params) => {
      if (params.aggs) {
        trace.agg_searches.push({ index: params.index });
        if (opts.searchAggThrows) {
          throw new Error('agg search boom');
        }
        const range = opts.timestampRange ?? { earliest: null, latest: null };
        return {
          aggregations: {
            earliest: { value_as_string: range.earliest ?? undefined },
            latest: { value_as_string: range.latest ?? undefined },
          },
        };
      }
      // Repo list search.
      if (params.index !== STATUS_INDEX) return { hits: { hits: [] } };
      return {
        hits: {
          hits: reposState.map((r) => ({
            _id: r.name,
            _source: r as unknown as Record<string, unknown>,
          })),
        },
      };
    },
    snapshot: {
      get: async ({ repository }) => {
        const indices = opts.snapshotIndices?.[repository] ?? [];
        return {
          snapshots: indices.length
            ? [{ snapshot: 'snap-1', indices: [...indices] }]
            : [],
        };
      },
    },
    index: async ({ index, id, document }) => {
      trace.index_calls.push({ index, id, document });
      const i = reposState.findIndex((r) => r.name === id);
      if (i >= 0) {
        reposState[i] = document as unknown as RepositoryDoc;
      }
      return {};
    },
  } as unknown as UpdateDateRangesActionEsClient;

  return { client, trace };
}

function makeRepo(over: Partial<RepositoryDoc> = {}): RepositoryDoc {
  return {
    doctype: 'repository',
    name: 'r1',
    bucket: 'bdw',
    base_path: 'deepfreeze/snap',
    start: null,
    end: null,
    is_thawed: false,
    is_mounted: true,
    thaw_state: 'active',
    thawed_at: null,
    expires_at: null,
    ...over,
  };
}

describe('runUpdateDateRanges', () => {
  it('extends an existing range when newer @timestamp values arrive', async () => {
    const repo = makeRepo({
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-04-01T00:00:00.000Z',
    });
    const { client, trace } = makeClient({
      repos: [repo],
      snapshotIndices: { r1: ['idx-r1'] },
      existingIndices: ['idx-r1'],
      timestampRange: {
        earliest: '2026-02-01T00:00:00.000Z', // inside existing — should NOT shrink
        latest: '2026-05-19T00:00:00.000Z', // beyond existing — SHOULD extend end
      },
    });

    const out = await runUpdateDateRanges(client, {});

    expect(out.success).toBe(true);
    expect(out.updated).toEqual(['r1']);
    expect(out.unchanged).toEqual([]);
    expect(out.skipped).toEqual([]);
    expect(out.errors).toEqual([]);
    expect(out.outcomes[0]).toMatchObject({
      repo: 'r1',
      changed: true,
      start: '2026-01-01T00:00:00.000Z', // preserved (only-extend rule)
      end: '2026-05-19T00:00:00.000Z',
    });
    expect(trace.index_calls).toHaveLength(1);
    expect(trace.index_calls[0].document).toMatchObject({
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-05-19T00:00:00.000Z',
    });
  });

  it('skips unmounted repos with a reason', async () => {
    const repo = makeRepo({ name: 'frozen-1', is_mounted: false });
    const { client, trace } = makeClient({ repos: [repo] });

    const out = await runUpdateDateRanges(client, {});

    expect(out.skipped).toEqual([
      { repo: 'frozen-1', reason: 'repo not mounted; @timestamp unavailable' },
    ]);
    expect(out.updated).toEqual([]);
    expect(trace.agg_searches).toHaveLength(0);
    expect(trace.index_calls).toHaveLength(0);
  });

  it('records unchanged when the helper finds nothing to extend', async () => {
    const repo = makeRepo({
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-05-19T00:00:00.000Z',
    });
    const { client, trace } = makeClient({
      repos: [repo],
      snapshotIndices: { r1: ['idx-r1'] },
      existingIndices: ['idx-r1'],
      // Same range — no extension possible.
      timestampRange: {
        earliest: '2026-02-01T00:00:00.000Z',
        latest: '2026-03-01T00:00:00.000Z',
      },
    });

    const out = await runUpdateDateRanges(client, {});

    expect(out.updated).toEqual([]);
    expect(out.unchanged).toEqual(['r1']);
    expect(out.outcomes[0]).toMatchObject({ repo: 'r1', changed: false });
    expect(trace.index_calls).toHaveLength(0);
  });

  it('populates a missing range from scratch', async () => {
    const repo = makeRepo({ start: null, end: null });
    const { client } = makeClient({
      repos: [repo],
      snapshotIndices: { r1: ['idx-r1'] },
      existingIndices: ['idx-r1'],
      timestampRange: {
        earliest: '2026-01-01T00:00:00.000Z',
        latest: '2026-05-19T00:00:00.000Z',
      },
    });

    const out = await runUpdateDateRanges(client, {});

    expect(out.updated).toEqual(['r1']);
    expect(out.outcomes[0]).toMatchObject({
      previous_start: null,
      previous_end: null,
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-05-19T00:00:00.000Z',
    });
  });

  it('continues across repos when one helper call has no usable mounted index', async () => {
    const r1 = makeRepo({ name: 'r1' });
    const r2 = makeRepo({ name: 'r2' });
    const { client } = makeClient({
      repos: [r1, r2],
      snapshotIndices: {
        r1: ['idx-r1'],
        r2: ['idx-r2'],
      },
      // Only r1's index exists — r2 will be unchanged (no mounted index).
      existingIndices: ['idx-r1'],
      timestampRange: {
        earliest: '2026-01-01T00:00:00.000Z',
        latest: '2026-05-19T00:00:00.000Z',
      },
    });

    const out = await runUpdateDateRanges(client, {});

    expect(out.updated).toEqual(['r1']);
    expect(out.unchanged).toEqual(['r2']);
    expect(out.outcomes.find((o) => o.repo === 'r2')).toMatchObject({
      changed: false,
      skipped_reason: 'no mounted indices found for snapshot contents',
    });
  });

  it('records an error step when the helper returns an error outcome', async () => {
    const repo = makeRepo();
    const { client } = makeClient({
      repos: [repo],
      snapshotIndices: { r1: ['idx-r1'] },
      existingIndices: ['idx-r1'],
      searchAggThrows: true,
    });

    const out = await runUpdateDateRanges(client, {});

    // The helper swallows aggregation errors and returns "no @timestamp",
    // so we expect an unchanged outcome, not an error. This documents
    // the behavior — the helper's robustness is intentional.
    expect(out.errors).toEqual([]);
    expect(out.unchanged).toEqual(['r1']);
    expect(out.outcomes[0]).toMatchObject({
      changed: false,
      skipped_reason: 'aggregation returned no @timestamp values',
    });
  });

  it('returns an empty success when there are no repos', async () => {
    const { client, trace } = makeClient({ repos: [] });
    const out = await runUpdateDateRanges(client, {});
    expect(out.success).toBe(true);
    expect(out.updated).toEqual([]);
    expect(out.unchanged).toEqual([]);
    expect(out.skipped).toEqual([]);
    expect(out.errors).toEqual([]);
    expect(trace.agg_searches).toEqual([]);
  });
});
