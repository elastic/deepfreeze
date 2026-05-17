import {
  getNextSuffix,
  runRotate,
  runRotateDryRun,
  type RotateActionEsClient,
} from '../rotate';
import {
  ActionError,
  MissingIndexError,
  MissingSettingsError,
} from '../../errors';
import { SETTINGS_DEFAULTS, type SettingsDoc } from '../../../common/schemas/settings';
import { DOCTYPE, SETTINGS_ID, STATUS_INDEX } from '../../../common/constants';
import type { RepositoryDoc } from '../../../common/schemas/repository';

function notFound(): Error {
  const e: Error & { statusCode?: number; meta?: { statusCode: number } } = new Error('nf');
  e.statusCode = 404;
  e.meta = { statusCode: 404 };
  return e;
}

interface FakeOpts {
  /** Settings doc returned from the status index; `null` → MissingSettingsError. */
  settings?: SettingsDoc | null;
  /** When true, indices.exists returns false → MissingIndexError. */
  statusIndexMissing?: boolean;
  /** Repository docs returned by getAllRepos. */
  repositoryDocs?: RepositoryDoc[];
  /** What `snapshot.getRepository()` returns. */
  liveRepos?: Record<string, { type: string; settings: Record<string, unknown> }>;
  /** Existing ILM policies (by name). */
  existingIlmPolicies?: Record<string, Record<string, unknown>>;
  /** Make `snapshot.createRepository` fail. */
  failCreate?: boolean;
  /** Make `snapshot.deleteRepository` fail for these names. */
  failDeleteForNames?: string[];
  /** Make `ilm.putLifecycle` fail. */
  failPutIlm?: boolean;
}

interface Trace {
  created_repos: Array<Record<string, unknown>>;
  deleted_repos: string[];
  index_calls: Array<{ index: string; id: string; document: Record<string, unknown> }>;
  ilm_puts: Array<{ name: string; policy: Record<string, unknown> }>;
}

function makeClient(
  opts: FakeOpts = {}
): { client: RotateActionEsClient; trace: Trace } {
  const trace: Trace = {
    created_repos: [],
    deleted_repos: [],
    index_calls: [],
    ilm_puts: [],
  };

  const liveRepos = opts.liveRepos ?? {};

  const client: RotateActionEsClient = {
    indices: {
      exists: async ({ index }) => {
        if (index === STATUS_INDEX) return !opts.statusIndexMissing;
        return false;
      },
    } as RotateActionEsClient['indices'],
    get: async ({ index, id }) => {
      if (index === STATUS_INDEX && id === SETTINGS_ID) {
        if (opts.settings === undefined) return { found: false };
        if (opts.settings === null) return { found: false };
        return { _source: opts.settings, found: true };
      }
      return { found: false };
    },
    search: async (params) => {
      const query = params.query as { match?: { doctype?: string } };
      if (query.match?.doctype === DOCTYPE.repository) {
        return {
          hits: {
            hits: (opts.repositoryDocs ?? []).map((d) => ({
              _id: d.name,
              _source: d as unknown as Record<string, unknown>,
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
    snapshot: {
      getRepository: async () => liveRepos as unknown as Record<string, unknown>,
      createRepository: async (args) => {
        if (opts.failCreate) throw new Error('boom-create');
        trace.created_repos.push(args);
        // Make the new repo visible to subsequent live-repo calls.
        liveRepos[args.name] = {
          type: args.repository.type,
          settings: args.repository.settings,
        };
        return {};
      },
      deleteRepository: async ({ name }) => {
        if (opts.failDeleteForNames?.includes(name)) {
          throw new Error(`boom-delete-${name}`);
        }
        trace.deleted_repos.push(name);
        delete liveRepos[name];
        return {};
      },
    },
    ilm: {
      getLifecycle: async ({ name }: { name?: string } = {}) => {
        if (!name) return opts.existingIlmPolicies ?? {};
        const p = opts.existingIlmPolicies?.[name];
        if (!p) throw notFound();
        return { [name]: p };
      },
      putLifecycle: async (args) => {
        if (opts.failPutIlm) throw new Error('boom-ilm');
        trace.ilm_puts.push(args);
        return {};
      },
    },
  };

  return { client, trace };
}

function settings(overrides: Partial<SettingsDoc> = {}): SettingsDoc {
  // The wizard always stores base_path_prefix under deepfreeze/; the tests
  // assume that real-world shape (SETTINGS_DEFAULTS by itself uses just
  // 'snapshots' as a sane default for fresh installs from the CLI).
  return {
    ...SETTINGS_DEFAULTS,
    base_path_prefix: 'deepfreeze/snapshots',
    last_suffix: '000001',
    ...overrides,
  };
}

function repoDoc(name: string, overrides: Partial<RepositoryDoc> = {}): RepositoryDoc {
  return {
    doctype: 'repository',
    name,
    bucket: 'my-bucket',
    base_path: `deepfreeze/snapshots-${name.split('-').pop()}`,
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

// -- getNextSuffix ---------------------------------------------------------

describe('getNextSuffix', () => {
  it('increments oneup suffix preserving 6-digit zero padding', () => {
    expect(getNextSuffix('oneup', '000001')).toBe('000002');
    expect(getNextSuffix('oneup', '000042')).toBe('000043');
    expect(getNextSuffix('oneup', '999999')).toBe('1000000');
  });

  it('treats null/empty last_suffix as 0 for the first oneup rotation', () => {
    expect(getNextSuffix('oneup', null)).toBe('000001');
  });

  it('rejects non-numeric last_suffix for oneup', () => {
    expect(() => getNextSuffix('oneup', 'abc')).toThrow(ActionError);
  });

  it('returns zero-padded YYYY.MM for date style', () => {
    expect(getNextSuffix('date', null, 2026, 5)).toBe('2026.05');
    expect(getNextSuffix('date', null, 2026, 11)).toBe('2026.11');
  });

  it('rejects out-of-range months', () => {
    expect(() => getNextSuffix('date', null, 2026, 0)).toThrow(ActionError);
    expect(() => getNextSuffix('date', null, 2026, 13)).toThrow(ActionError);
  });
});

// -- Preconditions ---------------------------------------------------------

describe('runRotate preconditions', () => {
  it('throws MissingIndexError when the status index is absent', async () => {
    const { client } = makeClient({ statusIndexMissing: true });
    await expect(runRotate(client)).rejects.toBeInstanceOf(MissingIndexError);
  });

  it('throws MissingSettingsError when settings doc is missing', async () => {
    const { client } = makeClient({ settings: null });
    await expect(runRotate(client)).rejects.toBeInstanceOf(MissingSettingsError);
  });

  it('throws ActionError when settings.rotate_by is "bucket"', async () => {
    const { client } = makeClient({ settings: settings({ rotate_by: 'bucket' }) });
    await expect(runRotate(client)).rejects.toBeInstanceOf(ActionError);
  });
});

// -- Dry-run ---------------------------------------------------------------

describe('runRotateDryRun', () => {
  it('reports the would-be new repo + suffix bump without mutating anything', async () => {
    const { client, trace } = makeClient({
      settings: settings({ last_suffix: '000005' }),
      repositoryDocs: [repoDoc('deepfreeze-000005')],
    });

    const result = await runRotateDryRun(client);
    expect(result.dry_run).toBe(true);
    expect(result.new_repo_name).toBe('deepfreeze-000006');
    expect(result.new_base_path).toBe('deepfreeze/snapshots-000006');
    expect(trace.created_repos).toHaveLength(0);
    expect(trace.deleted_repos).toHaveLength(0);
    expect(trace.index_calls).toHaveLength(0);
  });

  it('flags repos beyond keep window for archival', async () => {
    const { client } = makeClient({
      settings: settings({ last_suffix: '000003' }),
      repositoryDocs: [
        repoDoc('deepfreeze-000001'),
        repoDoc('deepfreeze-000002'),
        repoDoc('deepfreeze-000003'),
      ],
    });

    const result = await runRotateDryRun(client, { keep: 1 });
    // keep=1 means only the newest (deepfreeze-000003) survives; older two get archived
    expect(result.archived).toEqual(['deepfreeze-000001', 'deepfreeze-000002']);
  });

  it('skips repos in thawing/thawed state from the archive list', async () => {
    const { client } = makeClient({
      settings: settings({ last_suffix: '000003' }),
      repositoryDocs: [
        repoDoc('deepfreeze-000001', { thaw_state: 'thawing' }),
        repoDoc('deepfreeze-000002', { thaw_state: 'thawed' }),
        repoDoc('deepfreeze-000003'),
      ],
    });

    const result = await runRotateDryRun(client, { keep: 1 });
    expect(result.archived).toEqual([]);
  });

  it('includes the ILM step when settings.ilm_policy_name is set', async () => {
    const { client } = makeClient({
      settings: settings({ ilm_policy_name: 'logs-policy', last_suffix: '000005' }),
      repositoryDocs: [],
    });

    const result = await runRotateDryRun(client);
    expect(result.steps.some((s) => s.type === 'ilm_policy')).toBe(true);
  });
});

// -- Full runRotate --------------------------------------------------------

describe('runRotate happy path', () => {
  it('creates the new repo, bumps last_suffix, and writes the Repository doc', async () => {
    const { client, trace } = makeClient({
      settings: settings({ last_suffix: '000005' }),
      repositoryDocs: [repoDoc('deepfreeze-000005')],
    });

    const result = await runRotate(client);

    expect(result.success).toBe(true);
    expect(result.new_repo_name).toBe('deepfreeze-000006');
    expect(trace.created_repos[0]).toMatchObject({
      name: 'deepfreeze-000006',
      repository: { type: 's3' },
      verify: true,
    });

    // settings + repository doc both indexed
    const docs = trace.index_calls.map((c) => c.document as { doctype?: string }).map((d) => d.doctype);
    expect(docs).toEqual(expect.arrayContaining(['settings', 'repository']));

    const settingsCall = trace.index_calls.find(
      (c) => (c.document as { doctype?: string }).doctype === 'settings'
    );
    expect((settingsCall?.document as SettingsDoc).last_suffix).toBe('000006');
  });

  it('archives repos beyond keep count: unmounts them and flips thaw_state to frozen', async () => {
    const { client, trace } = makeClient({
      settings: settings({ last_suffix: '000003' }),
      repositoryDocs: [
        repoDoc('deepfreeze-000001'),
        repoDoc('deepfreeze-000002'),
        repoDoc('deepfreeze-000003'),
      ],
      liveRepos: {
        'deepfreeze-000001': { type: 's3', settings: { bucket: 'my-bucket' } },
        'deepfreeze-000002': { type: 's3', settings: { bucket: 'my-bucket' } },
        'deepfreeze-000003': { type: 's3', settings: { bucket: 'my-bucket' } },
      },
    });

    const result = await runRotate(client, { keep: 1 });
    expect(result.archived).toEqual(['deepfreeze-000001', 'deepfreeze-000002']);
    expect(trace.deleted_repos).toEqual(['deepfreeze-000001', 'deepfreeze-000002']);

    // Each archived repo got a follow-up index call with thaw_state: 'frozen'
    const frozenDocs = trace.index_calls
      .map((c) => c.document as Record<string, unknown>)
      .filter((d) => d.doctype === 'repository' && d.thaw_state === 'frozen');
    expect(frozenDocs.map((d) => d.name).sort()).toEqual([
      'deepfreeze-000001',
      'deepfreeze-000002',
    ]);
  });

  it('retargets the configured ILM policy to the new repo', async () => {
    const { client, trace } = makeClient({
      settings: settings({ ilm_policy_name: 'logs-policy', last_suffix: '000005' }),
      repositoryDocs: [],
    });

    await runRotate(client);

    expect(trace.ilm_puts).toHaveLength(1);
    expect(trace.ilm_puts[0].name).toBe('logs-policy');
  });
});

describe('runRotate partial failures', () => {
  it('records archive unmount failures as warnings and reports them in skipped[]', async () => {
    const { client } = makeClient({
      settings: settings({ last_suffix: '000003' }),
      repositoryDocs: [
        repoDoc('deepfreeze-000001'),
        repoDoc('deepfreeze-000002'),
      ],
      liveRepos: {
        'deepfreeze-000001': { type: 's3', settings: {} },
        'deepfreeze-000002': { type: 's3', settings: {} },
      },
      failDeleteForNames: ['deepfreeze-000001'],
    });

    const result = await runRotate(client, { keep: 1 });
    expect(result.success).toBe(true);
    expect(result.archived).toEqual([]); // deepfreeze-000001 failed; deepfreeze-000002 kept (it's the newest)
    expect(result.skipped).toEqual(['deepfreeze-000001']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: 'ACTION_FAILED',
      target: 'deepfreeze-000001',
      severity: 'warning',
    });
  });

  it('records ILM retarget failure as warning, does not abort', async () => {
    const { client } = makeClient({
      settings: settings({ ilm_policy_name: 'logs-policy', last_suffix: '000001' }),
      repositoryDocs: [],
      failPutIlm: true,
    });

    const result = await runRotate(client);
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].target).toBe('logs-policy');
  });

  it('propagates createRepository failures (no point continuing)', async () => {
    const { client } = makeClient({
      settings: settings(),
      failCreate: true,
    });
    await expect(runRotate(client)).rejects.toThrow('boom-create');
  });
});
