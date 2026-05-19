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
  /**
   * Existing ILM policies (by name). The fake wraps each entry into
   * the `{policy: {...}}` envelope ES returns, so pass the inner
   * `{phases: ...}` shape directly here.
   */
  existingIlmPolicies?: Record<string, Record<string, unknown>>;
  /**
   * Existing composable templates by name; each value's
   * `template.settings.index.lifecycle.name` is read to decide which
   * templates currently bind to a given policy.
   */
  existingIndexTemplates?: Record<string, Record<string, unknown>>;
  /** Legacy (pre-7.8) templates by name. */
  existingLegacyTemplates?: Record<string, Record<string, unknown>>;
  /**
   * Per-repo snapshot index lists. Keyed by repo name; each value is
   * the list of index names contained in that repo's snapshots.
   * Drives the date-range update path's snapshot.get() call.
   */
  snapshotIndices?: Record<string, string[]>;
  /** Index names that should exist when `indices.exists` queries. */
  existingIndices?: string[];
  /** Min/max @timestamp returned by the aggregation search. */
  timestampRange?: { earliest: string | null; latest: string | null };
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
  template_puts: Array<{ name: string; body: Record<string, unknown> }>;
  legacy_template_puts: Array<{ name: string; body: Record<string, unknown> }>;
}

function makeClient(
  opts: FakeOpts = {}
): { client: RotateActionEsClient; trace: Trace } {
  const trace: Trace = {
    created_repos: [],
    deleted_repos: [],
    index_calls: [],
    ilm_puts: [],
    template_puts: [],
    legacy_template_puts: [],
  };

  // Live store of policies that subsequent getLifecycle calls will see.
  // Seeded from existingIlmPolicies; putLifecycle writes here too so a
  // create-then-read flow within one test works as expected.
  const ilmPolicies: Record<string, Record<string, unknown>> = {
    ...(opts.existingIlmPolicies ?? {}),
  };
  const indexTemplates: Record<string, Record<string, unknown>> = {
    ...(opts.existingIndexTemplates ?? {}),
  };
  const legacyTemplates: Record<string, Record<string, unknown>> = {
    ...(opts.existingLegacyTemplates ?? {}),
  };

  const liveRepos = opts.liveRepos ?? {};

  const client: RotateActionEsClient = {
    indices: {
      exists: async ({ index }) => {
        if (index === STATUS_INDEX) return !opts.statusIndexMissing;
        // Date-range path probes for mounted index names; consult the
        // existingIndices set seeded by the test.
        return (opts.existingIndices ?? []).includes(index);
      },
      getIndexTemplate: async ({ name }: { name?: string } = {}) => {
        const items = Object.entries(indexTemplates).filter(
          ([n]) => name === undefined || n === name
        );
        if (items.length === 0 && name !== undefined) {
          throw notFound();
        }
        return {
          index_templates: items.map(([n, body]) => ({ name: n, index_template: body })),
        };
      },
      putIndexTemplate: async ({
        name,
        body,
      }: {
        name: string;
        body: Record<string, unknown>;
      }) => {
        trace.template_puts.push({ name, body });
        indexTemplates[name] = body;
        return {};
      },
      getTemplate: async ({ name }: { name?: string } = {}) => {
        if (name === undefined) return legacyTemplates;
        const tmpl = legacyTemplates[name];
        if (!tmpl) throw notFound();
        return { [name]: tmpl };
      },
      putTemplate: async ({
        name,
        body,
      }: {
        name: string;
        body: Record<string, unknown>;
      }) => {
        trace.legacy_template_puts.push({ name, body });
        legacyTemplates[name] = body;
        return {};
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
      // Aggregation search (date-range path's @timestamp min/max).
      if (params.aggs) {
        const range = opts.timestampRange ?? { earliest: null, latest: null };
        return {
          aggregations: {
            earliest: { value_as_string: range.earliest ?? undefined },
            latest: { value_as_string: range.latest ?? undefined },
          },
        };
      }
      const query = (params.query ?? {}) as { match?: { doctype?: string } };
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
      get: async ({ repository }: { repository: string; snapshot: string }) => {
        const indices = opts.snapshotIndices?.[repository] ?? [];
        return {
          snapshots: indices.length
            ? [{ snapshot: 'snap-1', indices: [...indices] }]
            : [],
        };
      },
    },
    ilm: {
      getLifecycle: async ({ name }: { name?: string } = {}) => {
        if (!name) {
          // Bulk read — wrap each policy in {policy: ...} as ES does.
          return Object.fromEntries(
            Object.entries(ilmPolicies).map(([n, p]) => [n, { policy: p }])
          );
        }
        const p = ilmPolicies[name];
        if (!p) throw notFound();
        return { [name]: { policy: p } };
      },
      putLifecycle: async (args) => {
        if (opts.failPutIlm) throw new Error('boom-ilm');
        trace.ilm_puts.push(args);
        ilmPolicies[args.name] = args.policy as Record<string, unknown>;
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

  it('defaults keep to 6 when the caller omits it', async () => {
    // 8 repos, no keep specified → 6 newest survive, oldest 2 archived.
    const { client } = makeClient({
      settings: settings({ last_suffix: '000008' }),
      repositoryDocs: Array.from({ length: 8 }, (_, i) =>
        repoDoc(`deepfreeze-${String(i + 1).padStart(6, '0')}`)
      ),
    });

    const result = await runRotateDryRun(client);
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

  it('creates a versioned ILM policy from the base on first rotation', async () => {
    // No `<base>-<old_suffix>` exists, so fall back to base policy.
    // Versioned policy `logs-policy-000006` should be created pointing at
    // the new repo; the base policy itself stays unmodified.
    const basePolicyBody = {
      phases: {
        hot: { min_age: '0ms', actions: { rollover: { max_size: '50gb' } } },
        frozen: {
          min_age: '30d',
          actions: { searchable_snapshot: { snapshot_repository: 'deepfreeze-000005' } },
        },
      },
    };
    const { client, trace } = makeClient({
      settings: settings({ ilm_policy_name: 'logs-policy', last_suffix: '000005' }),
      repositoryDocs: [],
      existingIlmPolicies: { 'logs-policy': basePolicyBody },
    });

    await runRotate(client);

    expect(trace.ilm_puts).toHaveLength(1);
    expect(trace.ilm_puts[0].name).toBe('logs-policy-000006');
    const writtenBody = trace.ilm_puts[0].policy as {
      phases: { frozen: { actions: { searchable_snapshot: { snapshot_repository: string } } } };
    };
    expect(writtenBody.phases.frozen.actions.searchable_snapshot.snapshot_repository).toBe(
      'deepfreeze-000006'
    );

    // Base policy stays unmodified — it's still in our fake's policy
    // store with the original repo reference.
    // (We assert this by NOT seeing a putLifecycle for 'logs-policy'.)
    expect(trace.ilm_puts.find((p) => p.name === 'logs-policy')).toBeUndefined();
  });

  it('prefers the previous versioned policy as the source on subsequent rotations', async () => {
    // base 'logs-policy' (points at -000001, original)
    // 'logs-policy-000005' (points at -000005, possibly operator-edited)
    // Rotate should clone from `-000005`, not from base.
    const editedFrozenPolicy = {
      phases: {
        // Hypothetical operator edit: frozen min_age changed since base.
        frozen: {
          min_age: '90d',
          actions: { searchable_snapshot: { snapshot_repository: 'deepfreeze-000005' } },
        },
      },
    };
    const basePolicyBody = {
      phases: {
        frozen: {
          min_age: '30d',
          actions: { searchable_snapshot: { snapshot_repository: 'deepfreeze-000001' } },
        },
      },
    };
    const { client, trace } = makeClient({
      settings: settings({ ilm_policy_name: 'logs-policy', last_suffix: '000005' }),
      repositoryDocs: [],
      existingIlmPolicies: {
        'logs-policy': basePolicyBody,
        'logs-policy-000005': editedFrozenPolicy,
      },
    });

    await runRotate(client);

    expect(trace.ilm_puts).toHaveLength(1);
    expect(trace.ilm_puts[0].name).toBe('logs-policy-000006');
    const writtenBody = trace.ilm_puts[0].policy as {
      phases: { frozen: { min_age: string; actions: { searchable_snapshot: { snapshot_repository: string } } } };
    };
    // The operator-edited min_age was preserved (proves we sourced from -000005, not base).
    expect(writtenBody.phases.frozen.min_age).toBe('90d');
    expect(writtenBody.phases.frozen.actions.searchable_snapshot.snapshot_repository).toBe(
      'deepfreeze-000006'
    );
  });

  it('rebinds composable templates from old policy → new versioned policy', async () => {
    const basePolicyBody = {
      phases: {
        frozen: {
          min_age: '30d',
          actions: { searchable_snapshot: { snapshot_repository: 'deepfreeze-000005' } },
        },
      },
    };
    const { client, trace } = makeClient({
      settings: settings({ ilm_policy_name: 'logs-policy', last_suffix: '000005' }),
      repositoryDocs: [],
      existingIlmPolicies: { 'logs-policy': basePolicyBody },
      existingIndexTemplates: {
        // This one currently binds to the base policy.
        'logs-template': {
          index_patterns: ['logs-*'],
          template: {
            settings: { index: { lifecycle: { name: 'logs-policy' } } },
          },
          composed_of: ['logs-mapping'],
        },
        // Unrelated template — should NOT be rebound.
        'metrics-template': {
          index_patterns: ['metrics-*'],
          template: {
            settings: { index: { lifecycle: { name: 'metrics-policy' } } },
          },
        },
      },
    });

    await runRotate(client);

    // logs-template got rebound to the new versioned policy
    const rebound = trace.template_puts.find((p) => p.name === 'logs-template');
    expect(rebound).toBeDefined();
    const reboundLifecycle = (
      ((rebound!.body.template as Record<string, unknown>).settings as Record<string, unknown>)
        .index as Record<string, unknown>
    ).lifecycle as { name: string };
    expect(reboundLifecycle.name).toBe('logs-policy-000006');

    // metrics-template was untouched
    expect(trace.template_puts.find((p) => p.name === 'metrics-template')).toBeUndefined();
  });

  it('rebinds templates currently bound to the previous versioned policy', async () => {
    // After several rotations the template should be pointing at
    // `logs-policy-000005` (not the base). This rotation should
    // rebind it to `logs-policy-000006`.
    const versionedBody = {
      phases: {
        frozen: {
          min_age: '30d',
          actions: { searchable_snapshot: { snapshot_repository: 'deepfreeze-000005' } },
        },
      },
    };
    const { client, trace } = makeClient({
      settings: settings({ ilm_policy_name: 'logs-policy', last_suffix: '000005' }),
      repositoryDocs: [],
      existingIlmPolicies: { 'logs-policy-000005': versionedBody },
      existingIndexTemplates: {
        'logs-template': {
          index_patterns: ['logs-*'],
          template: {
            settings: { index: { lifecycle: { name: 'logs-policy-000005' } } },
          },
        },
      },
    });

    await runRotate(client);

    const rebound = trace.template_puts.find((p) => p.name === 'logs-template');
    expect(rebound).toBeDefined();
    const reboundLifecycle = (
      ((rebound!.body.template as Record<string, unknown>).settings as Record<string, unknown>)
        .index as Record<string, unknown>
    ).lifecycle as { name: string };
    expect(reboundLifecycle.name).toBe('logs-policy-000006');
  });

  it('warns and skips ILM work when neither base nor previous versioned policy exists', async () => {
    const { client, trace } = makeClient({
      settings: settings({ ilm_policy_name: 'logs-policy', last_suffix: '000005' }),
      repositoryDocs: [],
      // No policies seeded.
    });

    const result = await runRotate(client);

    expect(trace.ilm_puts).toEqual([]);
    expect(trace.template_puts).toEqual([]);
    expect(
      result.errors.some((e) => e.target === 'logs-policy' && /not found/.test(e.message))
    ).toBe(true);
    // The rotation itself still succeeds.
    expect(result.success).toBe(true);
    expect(result.new_repo_name).toBe('deepfreeze-000006');
  });

  it('does not touch ILM at all when settings.ilm_policy_name is null', async () => {
    const { client, trace } = makeClient({
      settings: settings({ ilm_policy_name: null, last_suffix: '000005' }),
      repositoryDocs: [],
    });

    await runRotate(client);

    expect(trace.ilm_puts).toEqual([]);
    expect(trace.template_puts).toEqual([]);
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

describe('runRotate date-range update', () => {
  it('captures @timestamp ranges for every mounted repo before archive', async () => {
    // Two mounted repos with snapshotted indices. Both should have
    // their date ranges updated in the bulk pass that runs before
    // archive. keep=2 so neither gets archived.
    const repos = [
      repoDoc('deepfreeze-000001', { is_mounted: true }),
      repoDoc('deepfreeze-000002', { is_mounted: true }),
    ];
    const { client, trace } = makeClient({
      settings: settings({ last_suffix: '000002' }),
      repositoryDocs: repos,
      snapshotIndices: {
        'deepfreeze-000001': ['logs-jan'],
        'deepfreeze-000002': ['logs-feb'],
      },
      existingIndices: ['logs-jan', 'logs-feb'],
      timestampRange: {
        earliest: '2026-01-01T00:00:00Z',
        latest: '2026-02-28T00:00:00Z',
      },
    });

    const result = await runRotate(client, { keep: 2 });

    // Both repo docs get a date-range update write.
    const dateRangeWrites = trace.index_calls.filter((c) => {
      const doc = c.document as { doctype?: string; start?: string };
      return doc.doctype === 'repository' && doc.start === '2026-01-01T00:00:00Z';
    });
    expect(dateRangeWrites.map((c) => c.id).sort()).toEqual([
      'deepfreeze-000001',
      'deepfreeze-000002',
    ]);
    // Step records show two `date_range` entries.
    const dateRangeSteps = result.steps.filter((s) => s.type === 'date_range');
    expect(dateRangeSteps.map((s) => s.name).sort()).toEqual([
      'deepfreeze-000001',
      'deepfreeze-000002',
    ]);
    expect(dateRangeSteps.every((s) => s.action === 'updated')).toBe(true);
  });

  it('runs the per-repo backstop right before each unmount during archive', async () => {
    // 3 mounted repos, keep=1 → 2 oldest get archived. The backstop
    // call before each deleteSnapshotRepository should target each
    // archive candidate once.
    const repos = [
      repoDoc('deepfreeze-000001', { is_mounted: true }),
      repoDoc('deepfreeze-000002', { is_mounted: true }),
      repoDoc('deepfreeze-000003', { is_mounted: true }),
    ];
    const { client, trace } = makeClient({
      settings: settings({ last_suffix: '000003' }),
      repositoryDocs: repos,
      liveRepos: {
        'deepfreeze-000001': { type: 's3', settings: { bucket: 'my-bucket' } },
        'deepfreeze-000002': { type: 's3', settings: { bucket: 'my-bucket' } },
        'deepfreeze-000003': { type: 's3', settings: { bucket: 'my-bucket' } },
      },
      snapshotIndices: {
        'deepfreeze-000001': ['logs-jan'],
        'deepfreeze-000002': ['logs-feb'],
        'deepfreeze-000003': ['logs-mar'],
      },
      existingIndices: ['logs-jan', 'logs-feb', 'logs-mar'],
      timestampRange: {
        earliest: '2026-01-01T00:00:00Z',
        latest: '2026-03-31T00:00:00Z',
      },
    });

    const result = await runRotate(client, { keep: 1 });

    expect(result.archived).toEqual(['deepfreeze-000001', 'deepfreeze-000002']);
    // Verify both archived repos got a date-range write BEFORE their
    // unmount: each archived repo should appear in index_calls at
    // least once with start set (bulk pass) AND each archive flips
    // is_mounted=false (post-unmount). Verify the order via index_calls.
    const callsForR1 = trace.index_calls.filter((c) => c.id === 'deepfreeze-000001');
    const callsForR2 = trace.index_calls.filter((c) => c.id === 'deepfreeze-000002');
    expect(callsForR1.length).toBeGreaterThanOrEqual(2); // bulk update + frozen flip
    expect(callsForR2.length).toBeGreaterThanOrEqual(2);
    // The final write per repo flips to frozen.
    const lastR1 = callsForR1[callsForR1.length - 1].document as {
      thaw_state: string;
      is_mounted: boolean;
    };
    expect(lastR1.thaw_state).toBe('frozen');
    expect(lastR1.is_mounted).toBe(false);
  });

  it('emits informative skipped step when no snapshots exist yet (no writes)', async () => {
    // Fresh repos with no snapshots. snapshot.get returns empty, so
    // updateRepositoryDateRange short-circuits with skipped_reason.
    // The step is emitted so operators can tell WHY dates haven't
    // populated, but no writes happen.
    const { client, trace } = makeClient({
      settings: settings({ last_suffix: '000001' }),
      repositoryDocs: [repoDoc('deepfreeze-000001', { is_mounted: true })],
      snapshotIndices: { 'deepfreeze-000001': [] },
    });

    const result = await runRotate(client);
    const dateRangeSteps = result.steps.filter((s) => s.type === 'date_range');
    expect(dateRangeSteps).toEqual([
      {
        type: 'date_range',
        action: 'skipped',
        name: 'deepfreeze-000001',
        detail: 'no snapshots in repo',
      },
    ]);
    // No date_range index calls either.
    const dateRangeWrites = trace.index_calls.filter((c) => {
      const doc = c.document as { doctype?: string; start?: string };
      return doc.doctype === 'repository' && typeof doc.start === 'string';
    });
    expect(dateRangeWrites).toEqual([]);
  });

  it('only-extend merge: never shrinks an existing date range', async () => {
    // Repo already has a wide date range. Queried range is narrower —
    // the merge keeps the wider existing range and persists nothing
    // (no change).
    const repo = repoDoc('deepfreeze-000001', {
      is_mounted: true,
      start: '2025-12-01T00:00:00Z',
      end: '2026-03-31T00:00:00Z',
    });
    const { client, trace } = makeClient({
      settings: settings({ last_suffix: '000001' }),
      repositoryDocs: [repo],
      snapshotIndices: { 'deepfreeze-000001': ['logs-jan'] },
      existingIndices: ['logs-jan'],
      // Narrower than existing.
      timestampRange: {
        earliest: '2026-01-15T00:00:00Z',
        latest: '2026-01-20T00:00:00Z',
      },
    });

    await runRotate(client);

    // No repository writes that touch start/end — only the rotation's
    // own writes (the new repo doc, settings doc) should appear.
    const startEndWrites = trace.index_calls.filter((c) => {
      const doc = c.document as {
        doctype?: string;
        start?: string;
        name?: string;
      };
      return (
        doc.doctype === 'repository' &&
        doc.name === 'deepfreeze-000001' &&
        typeof doc.start === 'string'
      );
    });
    // The bulk-pass code only writes when changed; with only-extend
    // merge producing the same range, nothing is persisted.
    expect(startEndWrites).toEqual([]);
  });
});
