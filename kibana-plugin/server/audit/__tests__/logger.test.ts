import { AuditLogger } from '../logger';
import type { AuditEsClient } from '../types';
import { AUDIT_INDEX } from '../../../common/constants';

interface IndexCall {
  index: string;
  document: Record<string, unknown>;
}

interface SearchCall {
  index: string;
  query?: Record<string, unknown>;
  sort?: unknown;
  size?: number;
}

interface FakeClientOptions {
  existingIndices?: Set<string>;
  searchResults?: Array<Record<string, unknown>>;
  failIndex?: boolean;
  failSearch?: boolean;
  failCreate?: boolean;
}

function makeFakeClient(opts: FakeClientOptions = {}) {
  const indexCalls: IndexCall[] = [];
  const searchCalls: SearchCall[] = [];
  const createdIndices: string[] = [];
  const existing = new Set(opts.existingIndices ?? []);

  const client: AuditEsClient = {
    indices: {
      exists: async ({ index }) => existing.has(index),
      create: async ({ index }) => {
        if (opts.failCreate) {
          throw new Error('boom-create');
        }
        createdIndices.push(index);
        existing.add(index);
        return {};
      },
    },
    index: async (params) => {
      if (opts.failIndex) {
        throw new Error('boom-index');
      }
      indexCalls.push(params);
      return {};
    },
    search: async (params) => {
      if (opts.failSearch) {
        throw new Error('boom-search');
      }
      searchCalls.push(params);
      return {
        hits: { hits: (opts.searchResults ?? []).map((src) => ({ _source: src })) },
      };
    },
  };

  return { client, indexCalls, searchCalls, createdIndices };
}

describe('AuditLogger.logAction', () => {
  it('creates the audit index on first write and indexes the document', async () => {
    const { client, indexCalls, createdIndices } = makeFakeClient();
    const audit = new AuditLogger(client, { version: '2.0.2', hostname: 'kbn-1' });

    const ok = await audit.logAction({
      action: 'rotate',
      dryRun: false,
      success: true,
      durationMs: 1234,
      parameters: { keep: 6 },
      results: [{ type: 'repository', action: 'created' }],
      errors: [],
      summary: { new_repo: 'deepfreeze-000001' },
      user: 'alice',
    });

    expect(ok).toBe(true);
    expect(createdIndices).toEqual([AUDIT_INDEX]);
    expect(indexCalls).toHaveLength(1);

    const doc = indexCalls[0].document;
    expect(indexCalls[0].index).toBe(AUDIT_INDEX);
    expect(doc.action).toBe('rotate');
    expect(doc.dry_run).toBe(false);
    expect(doc.success).toBe(true);
    expect(doc.duration_ms).toBe(1234);
    expect(doc.parameters).toEqual({ keep: 6 });
    expect(doc.user).toBe('alice');
    expect(doc.hostname).toBe('kbn-1');
    expect(doc.version).toBe('2.0.2');
    expect(doc.summary).toEqual({ new_repo: 'deepfreeze-000001' });
    expect(typeof doc.timestamp).toBe('string');
  });

  it('coerces a null summary to an empty object (Python parity)', async () => {
    const { client, indexCalls } = makeFakeClient();
    const audit = new AuditLogger(client);

    await audit.logAction({
      action: 'cleanup',
      dryRun: true,
      success: true,
      durationMs: 0,
      parameters: {},
      results: [],
      errors: [],
      summary: null,
      user: 'system',
    });

    expect(indexCalls[0].document.summary).toEqual({});
  });

  it('does not recreate the audit index when it already exists', async () => {
    const { client, indexCalls, createdIndices } = makeFakeClient({
      existingIndices: new Set([AUDIT_INDEX]),
    });
    const audit = new AuditLogger(client);

    await audit.logAction({
      action: 'status',
      dryRun: false,
      success: true,
      durationMs: 10,
      parameters: {},
      results: [],
      errors: [],
      user: 'bob',
    });

    expect(createdIndices).toEqual([]);
    expect(indexCalls).toHaveLength(1);
  });

  it('returns false and swallows the error when index() throws (fail-silent contract)', async () => {
    const warnings: string[] = [];
    const { client } = makeFakeClient({
      existingIndices: new Set([AUDIT_INDEX]),
      failIndex: true,
    });
    const audit = new AuditLogger(client, {
      log: { debug: () => {}, warn: (m) => warnings.push(m) },
    });

    const ok = await audit.logAction({
      action: 'rotate',
      dryRun: false,
      success: true,
      durationMs: 1,
      parameters: {},
      results: [],
      errors: [],
      user: 'eve',
    });

    expect(ok).toBe(false);
    expect(warnings.some((w) => w.includes('boom-index'))).toBe(true);
  });

  it('skips all work when disabled', async () => {
    const { client, indexCalls } = makeFakeClient();
    const audit = new AuditLogger(client, { enabled: false });

    const ok = await audit.logAction({
      action: 'rotate',
      dryRun: false,
      success: true,
      durationMs: 1,
      parameters: {},
      results: [],
      errors: [],
      user: 'eve',
    });

    expect(ok).toBe(false);
    expect(indexCalls).toHaveLength(0);
  });
});

describe('AuditLogger.track', () => {
  it('commits a success row when the callback resolves', async () => {
    const { client, indexCalls } = makeFakeClient({ existingIndices: new Set([AUDIT_INDEX]) });
    const audit = new AuditLogger(client);

    const value = await audit.track(
      { action: 'rotate', dryRun: false, parameters: { keep: 6 }, user: 'alice' },
      async (tracker) => {
        tracker.addResult({ type: 'repository', action: 'created' });
        tracker.setSummary({ new_repo: 'deepfreeze-000001' });
        return 42;
      }
    );

    expect(value).toBe(42);
    expect(indexCalls).toHaveLength(1);
    const doc = indexCalls[0].document;
    expect(doc.success).toBe(true);
    expect(doc.results).toEqual([{ type: 'repository', action: 'created' }]);
    expect(doc.summary).toEqual({ new_repo: 'deepfreeze-000001' });
  });

  it('commits a failure row and re-throws when the callback rejects', async () => {
    const { client, indexCalls } = makeFakeClient({ existingIndices: new Set([AUDIT_INDEX]) });
    const audit = new AuditLogger(client);

    await expect(
      audit.track(
        { action: 'thaw', dryRun: false, parameters: {}, user: 'alice' },
        async () => {
          throw new Error('glacier-down');
        }
      )
    ).rejects.toThrow('glacier-down');

    expect(indexCalls).toHaveLength(1);
    expect(indexCalls[0].document.success).toBe(false);
  });

  it('records tracker errors in the audit row even when the callback resolves', async () => {
    // Python parity: at the end of `track`, an exception-free exit calls
    // `markSuccess()`, which overrides the failure state set by prior
    // `addError()` calls. The recorded error entries themselves are
    // still written. Callers that want success=false on a partial
    // failure must throw, or call `tracker.markFailed()` explicitly.
    const { client, indexCalls } = makeFakeClient({ existingIndices: new Set([AUDIT_INDEX]) });
    const audit = new AuditLogger(client);

    await audit.track(
      { action: 'cleanup', dryRun: false, parameters: {}, user: 'alice' },
      async (tracker) => {
        tracker.addError({ code: 'PARTIAL', message: 'one repo failed' });
      }
    );

    const doc = indexCalls[0].document;
    expect(doc.errors).toEqual([{ code: 'PARTIAL', message: 'one repo failed' }]);
    expect(doc.success).toBe(true);
  });
});

describe('AuditLogger.getRecentEntries', () => {
  it('returns [] when the index does not exist', async () => {
    const { client, searchCalls } = makeFakeClient();
    const audit = new AuditLogger(client);

    const entries = await audit.getRecentEntries();

    expect(entries).toEqual([]);
    expect(searchCalls).toHaveLength(0);
  });

  it('returns sources from search hits, newest first via sort', async () => {
    const { client, searchCalls } = makeFakeClient({
      existingIndices: new Set([AUDIT_INDEX]),
      searchResults: [
        { action: 'rotate', timestamp: '2026-05-15T12:00:00Z' },
        { action: 'thaw', timestamp: '2026-05-14T12:00:00Z' },
      ],
    });
    const audit = new AuditLogger(client);

    const entries = await audit.getRecentEntries({ limit: 50 });

    expect(entries).toHaveLength(2);
    expect(entries[0].action).toBe('rotate');
    expect(searchCalls[0].size).toBe(50);
    expect(searchCalls[0].sort).toEqual([{ timestamp: { order: 'desc' } }]);
    expect(searchCalls[0].query).toEqual({ match_all: {} });
  });

  it('applies the action filter as a term query when provided', async () => {
    const { client, searchCalls } = makeFakeClient({
      existingIndices: new Set([AUDIT_INDEX]),
      searchResults: [{ action: 'thaw' }],
    });
    const audit = new AuditLogger(client);

    await audit.getRecentEntries({ actionFilter: 'thaw' });

    expect(searchCalls[0].query).toEqual({ term: { action: 'thaw' } });
  });

  it('returns [] and warns when search throws (fail-silent)', async () => {
    const warnings: string[] = [];
    const { client } = makeFakeClient({
      existingIndices: new Set([AUDIT_INDEX]),
      failSearch: true,
    });
    const audit = new AuditLogger(client, {
      log: { debug: () => {}, warn: (m) => warnings.push(m) },
    });

    const entries = await audit.getRecentEntries();

    expect(entries).toEqual([]);
    expect(warnings.some((w) => w.includes('boom-search'))).toBe(true);
  });
});
