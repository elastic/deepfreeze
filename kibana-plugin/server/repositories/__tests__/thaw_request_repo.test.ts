import {
  listInProgressThawRequests,
  listThawRequests,
  type ThawRequestRepoEsClient,
} from '../thaw_request_repo';
import { DOCTYPE, STATUS_INDEX } from '../../../common/constants';
import { ActionError } from '../../errors';

interface FakeOpts {
  hits?: Array<{ _id: string; _source: Record<string, unknown> }>;
  searchThrows?: unknown;
  /** When set, the fake records the query that was sent for assertion. */
  capturedQuery?: { value: unknown };
}

function makeClient(opts: FakeOpts = {}): ThawRequestRepoEsClient {
  return {
    search: async (params) => {
      expect(params.index).toBe(STATUS_INDEX);
      expect(params.size).toBe(10000);
      if (opts.capturedQuery) {
        opts.capturedQuery.value = params.query;
      } else {
        expect(params.query).toEqual({ term: { doctype: DOCTYPE.thaw_request } });
      }
      if (opts.searchThrows) {
        throw opts.searchThrows;
      }
      return { hits: { hits: opts.hits ?? [] } };
    },
  };
}

describe('listThawRequests', () => {
  it('returns the _source of every thaw_request hit', async () => {
    const client = makeClient({
      hits: [
        {
          _id: 'req-1',
          _source: {
            doctype: 'thaw_request',
            request_id: 'req-1',
            repos: ['deepfreeze-000001'],
            status: 'in_progress',
            created_at: '2026-05-15T12:00:00Z',
          },
        },
      ],
    });

    const requests = await listThawRequests(client);

    expect(requests).toHaveLength(1);
    expect(requests[0].request_id).toBe('req-1');
    expect(requests[0].status).toBe('in_progress');
  });

  it('returns [] on 404 (Python parity: missing index = no requests)', async () => {
    const client = makeClient({ searchThrows: { statusCode: 404 } });
    await expect(listThawRequests(client)).resolves.toEqual([]);
  });

  it('also detects 404 from meta.statusCode (alternate client shape)', async () => {
    const client = makeClient({ searchThrows: { meta: { statusCode: 404 } } });
    await expect(listThawRequests(client)).resolves.toEqual([]);
  });

  it('wraps non-404 errors in ActionError', async () => {
    const client = makeClient({ searchThrows: new Error('cluster-unreachable') });
    await expect(listThawRequests(client)).rejects.toBeInstanceOf(ActionError);
    await expect(listThawRequests(client)).rejects.toThrow('cluster-unreachable');
  });
});

describe('listInProgressThawRequests', () => {
  it('issues a bool/must query that filters by both doctype and status=in_progress', async () => {
    const capturedQuery = { value: undefined as unknown };
    const client = makeClient({
      hits: [
        {
          _id: 'req-2',
          _source: {
            doctype: 'thaw_request',
            request_id: 'req-2',
            repos: ['deepfreeze-000002'],
            status: 'in_progress',
            created_at: '2026-05-15T12:00:00Z',
          },
        },
      ],
      capturedQuery,
    });

    const out = await listInProgressThawRequests(client);

    expect(capturedQuery.value).toEqual({
      bool: {
        must: [
          { term: { doctype: DOCTYPE.thaw_request } },
          { term: { status: 'in_progress' } },
        ],
      },
    });
    expect(out.map((r) => r.request_id)).toEqual(['req-2']);
  });

  it('returns [] on 404 (missing status index)', async () => {
    const client = makeClient({
      searchThrows: { statusCode: 404 },
      capturedQuery: { value: undefined },
    });
    await expect(listInProgressThawRequests(client)).resolves.toEqual([]);
  });

  it('wraps non-404 errors in ActionError', async () => {
    const client = makeClient({
      searchThrows: new Error('cluster-fail'),
      capturedQuery: { value: undefined },
    });
    await expect(listInProgressThawRequests(client)).rejects.toBeInstanceOf(
      ActionError
    );
    await expect(listInProgressThawRequests(client)).rejects.toThrow(
      'in-progress thaw requests'
    );
  });
});
