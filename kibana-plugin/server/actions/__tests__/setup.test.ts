import {
  computeSuffix,
  getSetupOptions,
  resolveNaming,
  runSetup,
  runSetupDryRun,
  type SetupActionEsClient,
  type SetupConfig,
} from '../setup';
import { PreconditionError, ActionError } from '../../errors';
import { SETTINGS_DEFAULTS } from '../../../common/schemas/settings';
import { AUDIT_INDEX, STATUS_INDEX } from '../../../common/constants';

/** Default config used as a baseline; tests override only the fields they need. */
function defaultConfig(overrides: Partial<SetupConfig> = {}): SetupConfig {
  return {
    repo_name_prefix: 'deepfreeze',
    bucket_name_prefix: 'my-bucket',
    base_path_prefix: 'deepfreeze/snapshots',
    canned_acl: 'private',
    storage_class: 'intelligent_tiering',
    provider: 'aws',
    rotate_by: 'path',
    style: 'oneup',
    ...overrides,
  };
}

interface FakeOpts {
  statusIndexExists?: boolean;
  auditIndexExists?: boolean;
  /** What `_snapshot/_all` returns. */
  existingSnapshotRepos?: Record<string, { type: string; settings: Record<string, unknown> }>;
  /** Composable templates by name. */
  existingTemplates?: Record<string, Record<string, unknown>>;
  /** Legacy (pre-7.8) templates by name. */
  existingLegacyTemplates?: Record<string, Record<string, unknown>>;
  /** Existing ILM policies. */
  existingIlmPolicies?: Record<string, Record<string, unknown>>;
  /** Make `snapshot.createRepository` fail (e.g. bucket unreachable). */
  failCreateRepo?: boolean;
  /** Make `ilm.putLifecycle` fail. */
  failPutIlm?: boolean;
  /** Make `indices.putIndexTemplate` / `indices.putTemplate` fail. */
  failPutTemplate?: boolean;
}

interface Trace {
  status_index_created?: boolean;
  audit_index_created?: boolean;
  settings_indexed?: Record<string, unknown>;
  repo_doc_indexed?: Record<string, unknown>;
  repo_created?: Record<string, unknown>;
  /** All putLifecycle calls in order. Setup may write both base and versioned. */
  ilm_puts: Array<{ name: string; policy: Record<string, unknown> }>;
  template_put?: { name: string; body: Record<string, unknown> };
  legacy_template_put?: { name: string; body: Record<string, unknown> };
}

function notFound(): Error {
  const e: Error & { statusCode?: number; meta?: { statusCode: number } } = new Error('nf');
  e.statusCode = 404;
  e.meta = { statusCode: 404 };
  return e;
}

function makeClient(opts: FakeOpts = {}): { client: SetupActionEsClient; trace: Trace } {
  const trace: Trace = { ilm_puts: [] };

  const client: SetupActionEsClient = {
    indices: {
      exists: async ({ index }) => {
        if (index === STATUS_INDEX) return opts.statusIndexExists ?? false;
        if (index === AUDIT_INDEX) return opts.auditIndexExists ?? false;
        return false;
      },
      create: async ({ index }) => {
        if (index === STATUS_INDEX) trace.status_index_created = true;
        if (index === AUDIT_INDEX) trace.audit_index_created = true;
        return {};
      },
      getIndexTemplate: async ({ name }: { name?: string } = {}) => {
        // Bulk read: return every template the test seeded.
        if (name === undefined) {
          const items = Object.entries(opts.existingTemplates ?? {});
          return {
            index_templates: items.map(([n, body]) => ({ name: n, index_template: body })),
          };
        }
        const tmpl = opts.existingTemplates?.[name];
        if (!tmpl) throw notFound();
        return { index_templates: [{ name, index_template: tmpl }] };
      },
      putIndexTemplate: async (args) => {
        if (opts.failPutTemplate) throw new Error('boom-template');
        trace.template_put = args;
        return {};
      },
      getTemplate: async ({ name }: { name?: string } = {}) => {
        if (name === undefined) return opts.existingLegacyTemplates ?? {};
        const tmpl = opts.existingLegacyTemplates?.[name];
        if (!tmpl) throw notFound();
        return { [name]: tmpl };
      },
      putTemplate: async (args) => {
        if (opts.failPutTemplate) throw new Error('boom-template');
        trace.legacy_template_put = args;
        return {};
      },
    },
    get: async () => ({ found: true }),
    index: async (args) => {
      // Settings doc uses SETTINGS_ID; Repository doc uses the repo name —
      // distinguish so tests can assert on each independently.
      if ((args.document as { doctype?: string }).doctype === 'repository') {
        trace.repo_doc_indexed = args;
      } else {
        trace.settings_indexed = args;
      }
      return {};
    },
    snapshot: {
      getRepository: async () => opts.existingSnapshotRepos ?? {},
      createRepository: async (args) => {
        if (opts.failCreateRepo) throw new Error('boom-create-repo');
        trace.repo_created = args;
        return {};
      },
    },
    ilm: {
      getLifecycle: async ({ name }: { name?: string } = {}) => {
        if (!name) {
          // Bulk read — wrap each policy in {policy: ...} as ES does.
          return Object.fromEntries(
            Object.entries(opts.existingIlmPolicies ?? {}).map(([n, p]) => [
              n,
              { policy: p },
            ])
          );
        }
        const p = opts.existingIlmPolicies?.[name];
        if (!p) throw notFound();
        return { [name]: { policy: p } };
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

// -- Pure helper unit tests ------------------------------------------------

describe('computeSuffix', () => {
  it('returns 000001 for oneup style', () => {
    expect(computeSuffix({ style: 'oneup' })).toBe('000001');
  });
  it('returns zero-padded YYYY.MM for date style', () => {
    expect(computeSuffix({ style: 'date', year: 2026, month: 5 })).toBe('2026.05');
  });
  it('throws when date style is missing year/month', () => {
    expect(() => computeSuffix({ style: 'date' })).toThrow(ActionError);
  });
});

describe('resolveNaming', () => {
  it('rotate_by=path: shared bucket, suffix appended to base_path', () => {
    const n = resolveNaming(defaultConfig({ rotate_by: 'path' }));
    expect(n).toEqual({
      suffix: '000001',
      new_repo_name: 'deepfreeze-000001',
      new_bucket: 'my-bucket',
      new_base_path: 'deepfreeze/snapshots-000001',
    });
  });

  it('rotate_by=bucket: per-rotation bucket, bare base_path', () => {
    const n = resolveNaming(defaultConfig({ rotate_by: 'bucket' }));
    expect(n).toEqual({
      suffix: '000001',
      new_repo_name: 'deepfreeze-000001',
      new_bucket: 'my-bucket-000001',
      new_base_path: 'deepfreeze/snapshots',
    });
  });
});

// -- getSetupOptions -------------------------------------------------------

describe('getSetupOptions', () => {
  it('returns buckets, ILM policy names, index template names, and s3 client names', async () => {
    const { client } = makeClient({
      existingSnapshotRepos: {
        a: { type: 's3', settings: { bucket: 'b1', base_path: 'p1' } },
        b: { type: 's3', settings: { bucket: 'b2', base_path: 'p2', client: 'archive' } },
      },
      existingIlmPolicies: {
        'zeta-policy': { phases: {} },
        'alpha-policy': { phases: {} },
      },
      existingTemplates: {
        'logs-template': { index_patterns: ['logs-*'] },
        'metrics-template': { index_patterns: ['metrics-*'] },
      },
    });

    // All lists arrive sorted for stable display.
    expect(await getSetupOptions(client)).toEqual({
      buckets_in_use: ['b1', 'b2'],
      ilm_policy_names: ['alpha-policy', 'zeta-policy'],
      index_template_names: ['logs-template', 'metrics-template'],
      s3_client_names: ['archive', 'default'],
    });
  });

  it('returns empty arrays on a bare cluster', async () => {
    const { client } = makeClient({});
    expect(await getSetupOptions(client)).toEqual({
      buckets_in_use: [],
      ilm_policy_names: [],
      index_template_names: [],
      s3_client_names: [],
    });
  });

  it('merges composable + legacy templates into a single sorted list', async () => {
    const { client } = makeClient({
      existingTemplates: { 'zeta-tmpl': { index_patterns: ['z*'] } },
      existingLegacyTemplates: { 'alpha-tmpl': { index_patterns: ['a*'] } },
    });
    const opts = await getSetupOptions(client);
    expect(opts.index_template_names).toEqual(['alpha-tmpl', 'zeta-tmpl']);
  });
});

// -- Precondition failures -------------------------------------------------

describe('runSetupDryRun precondition checks', () => {
  it('fails when the status index already exists', async () => {
    const { client } = makeClient({
      statusIndexExists: true,
      existingSnapshotRepos: { x: { type: 's3', settings: { bucket: 'my-bucket' } } },
    });

    const err = await runSetupDryRun(client, defaultConfig()).catch((e) => e);
    expect(err).toBeInstanceOf(PreconditionError);
    expect(err.issues.join(' ')).toMatch(/Status index/);
  });

  it('fails when a repo already matches the repo_name_prefix', async () => {
    const { client } = makeClient({
      existingSnapshotRepos: {
        'deepfreeze-existing': { type: 's3', settings: { bucket: 'my-bucket' } },
      },
    });

    const err = await runSetupDryRun(client, defaultConfig()).catch((e) => e);
    expect(err).toBeInstanceOf(PreconditionError);
    expect(err.issues.join(' ')).toMatch(/matching prefix/);
  });

  it('fails when the chosen bucket is not in use by any existing repo', async () => {
    const { client } = makeClient({
      existingSnapshotRepos: {
        other: { type: 's3', settings: { bucket: 'other-bucket', base_path: 'x' } },
      },
    });

    const err = await runSetupDryRun(client, defaultConfig()).catch((e) => e);
    expect(err).toBeInstanceOf(PreconditionError);
    expect(err.issues.join(' ')).toMatch(/is not in use/);
  });

  it('fails when the chosen bucket+base_path combo collides with an existing repo', async () => {
    const { client } = makeClient({
      existingSnapshotRepos: {
        // Same bucket+base_path the wizard would create:
        other: {
          type: 's3',
          settings: { bucket: 'my-bucket', base_path: 'deepfreeze/snapshots-000001' },
        },
      },
    });

    // The prefix check would fire too; pick a non-conflicting prefix for this test.
    const err = await runSetupDryRun(
      client,
      defaultConfig({ repo_name_prefix: 'mydeepfreeze' })
    ).catch((e) => e);
    expect(err).toBeInstanceOf(PreconditionError);
    expect(err.issues.join(' ')).toMatch(/already in use/);
  });

  it('fails when index_template_name is set but the template does not exist', async () => {
    const { client } = makeClient({
      existingSnapshotRepos: { other: { type: 's3', settings: { bucket: 'my-bucket' } } },
    });

    const err = await runSetupDryRun(
      client,
      defaultConfig({ index_template_name: 'logs-template', ilm_policy_name: 'logs-policy' })
    ).catch((e) => e);
    expect(err).toBeInstanceOf(PreconditionError);
    expect(err.issues.join(' ')).toMatch(/index template/i);
  });
});

// -- Dry-run success -------------------------------------------------------

describe('runSetupDryRun success', () => {
  it('returns the would-be steps without writing anything', async () => {
    const { client, trace } = makeClient({
      existingSnapshotRepos: { other: { type: 's3', settings: { bucket: 'my-bucket' } } },
    });

    const result = await runSetupDryRun(client, defaultConfig());
    expect(result.success).toBe(true);
    expect(result.dry_run).toBe(true);
    expect(result.new_repo_name).toBe('deepfreeze-000001');
    expect(result.new_bucket).toBe('my-bucket');
    expect(result.new_base_path).toBe('deepfreeze/snapshots-000001');
    expect(result.steps.map((s) => s.type)).toEqual([
      'status_index',
      'audit_index',
      'settings',
      'snapshot_repository',
    ]);
    // No writes happened
    expect(trace.ilm_puts).toEqual([]);
    expect(trace.template_put).toBeUndefined();
    expect(trace.repo_created).toBeUndefined();
    expect(trace.settings_indexed).toBeUndefined();
    expect(trace.status_index_created).toBeUndefined();
    expect(trace.audit_index_created).toBeUndefined();
  });

  it('includes ilm_policy and index_template steps when configured', async () => {
    const { client } = makeClient({
      existingSnapshotRepos: { other: { type: 's3', settings: { bucket: 'my-bucket' } } },
      existingTemplates: { 'logs-template': { index_patterns: ['logs-*'] } },
    });

    const result = await runSetupDryRun(
      client,
      defaultConfig({ ilm_policy_name: 'logs-policy', index_template_name: 'logs-template' })
    );

    expect(result.steps.map((s) => s.type)).toEqual([
      'status_index',
      'audit_index',
      'settings',
      'snapshot_repository',
      'ilm_policy',
      'index_template',
    ]);
  });
});

// -- Full runSetup ---------------------------------------------------------

describe('runSetup happy path', () => {
  it('creates the indices, saves settings, and registers the snapshot repo', async () => {
    const { client, trace } = makeClient({
      existingSnapshotRepos: { other: { type: 's3', settings: { bucket: 'my-bucket' } } },
    });

    const result = await runSetup(client, defaultConfig());

    expect(result.success).toBe(true);
    expect(result.dry_run).toBe(false);
    expect(result.errors).toEqual([]);

    expect(trace.status_index_created).toBe(true);
    expect(trace.audit_index_created).toBe(true);
    expect(trace.settings_indexed).toMatchObject({
      index: STATUS_INDEX,
      document: expect.objectContaining({
        doctype: 'settings',
        repo_name_prefix: 'deepfreeze',
        last_suffix: '000001',
      }),
    });
    expect(trace.repo_created).toMatchObject({
      name: 'deepfreeze-000001',
      repository: {
        type: 's3',
        settings: expect.objectContaining({
          bucket: 'my-bucket',
          base_path: 'deepfreeze/snapshots-000001',
        }),
      },
      verify: true,
    });
  });

  it('creates base + versioned ILM policy when configured and the base did not exist', async () => {
    // No existing policy → Setup creates the base from defaults, then
    // creates `<base>-<suffix>` as the first versioned copy.
    const { client, trace } = makeClient({
      existingSnapshotRepos: { other: { type: 's3', settings: { bucket: 'my-bucket' } } },
    });

    const result = await runSetup(client, defaultConfig({ ilm_policy_name: 'logs-policy' }));

    expect(result.errors).toEqual([]);
    expect(trace.ilm_puts.map((p) => p.name)).toEqual([
      'logs-policy',
      'logs-policy-000001',
    ]);
    // Both reference the new repo in their frozen phase.
    for (const put of trace.ilm_puts) {
      const phases = (put.policy as { phases: Record<string, unknown> }).phases;
      const frozen = phases.frozen as {
        actions: { searchable_snapshot: { snapshot_repository: string } };
      };
      expect(frozen.actions.searchable_snapshot.snapshot_repository).toBe(
        'deepfreeze-000001'
      );
    }
    const ilmSteps = result.steps.filter((s) => s.type === 'ilm_policy');
    expect(ilmSteps.map((s) => s.name)).toEqual(['logs-policy', 'logs-policy-000001']);
    expect(ilmSteps.map((s) => s.action)).toEqual(['created', 'created']);
  });

  it('leaves the existing base ILM policy as-is and only creates the versioned copy', async () => {
    const operatorEditedBase = {
      // Operator edited frozen.min_age to 90d before running Setup.
      phases: {
        frozen: {
          min_age: '90d',
          actions: { searchable_snapshot: { snapshot_repository: 'placeholder' } },
        },
      },
    };
    const { client, trace } = makeClient({
      existingSnapshotRepos: { other: { type: 's3', settings: { bucket: 'my-bucket' } } },
      existingIlmPolicies: { 'logs-policy': operatorEditedBase },
    });

    const result = await runSetup(client, defaultConfig({ ilm_policy_name: 'logs-policy' }));

    expect(result.errors).toEqual([]);
    // ONLY the versioned policy was written; the base is untouched.
    expect(trace.ilm_puts.map((p) => p.name)).toEqual(['logs-policy-000001']);
    // The versioned copy preserved the operator's min_age=90d edit and
    // retargeted snapshot_repository.
    const versioned = trace.ilm_puts[0];
    const phases = (versioned.policy as { phases: Record<string, unknown> }).phases;
    const frozen = phases.frozen as {
      min_age: string;
      actions: { searchable_snapshot: { snapshot_repository: string } };
    };
    expect(frozen.min_age).toBe('90d');
    expect(frozen.actions.searchable_snapshot.snapshot_repository).toBe(
      'deepfreeze-000001'
    );
    const ilmSteps = result.steps.filter((s) => s.type === 'ilm_policy');
    expect(ilmSteps.map((s) => s.action)).toEqual(['unchanged', 'created']);
  });

  it('binds the index template to the versioned policy, not the base', async () => {
    const { client, trace } = makeClient({
      existingSnapshotRepos: { other: { type: 's3', settings: { bucket: 'my-bucket' } } },
      existingTemplates: {
        'logs-template': {
          index_patterns: ['logs-*'],
          template: { settings: { index: { lifecycle: { name: 'old' } } } },
        },
      },
    });

    const result = await runSetup(
      client,
      defaultConfig({ ilm_policy_name: 'logs-policy', index_template_name: 'logs-template' })
    );

    expect(result.errors).toEqual([]);
    expect(trace.template_put?.name).toBe('logs-template');
    // The template's lifecycle.name should now point at the versioned policy.
    const lifecycle = (
      (
        (trace.template_put!.body.template as Record<string, unknown>).settings as Record<
          string,
          unknown
        >
      ).index as Record<string, unknown>
    ).lifecycle as { name: string };
    expect(lifecycle.name).toBe('logs-policy-000001');
    expect(result.steps.find((s) => s.type === 'index_template')?.action).toBe('updated');
  });
});

describe('runSetup partial failure', () => {
  it('records ILM failure as a warning but still succeeds overall', async () => {
    const { client } = makeClient({
      existingSnapshotRepos: { other: { type: 's3', settings: { bucket: 'my-bucket' } } },
      failPutIlm: true,
    });

    const result = await runSetup(client, defaultConfig({ ilm_policy_name: 'logs-policy' }));
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: 'ACTION_FAILED',
      severity: 'warning',
      target: 'logs-policy',
    });
  });

  it('rolls all the way through preconditions and propagates createRepository errors', async () => {
    const { client } = makeClient({
      existingSnapshotRepos: { other: { type: 's3', settings: { bucket: 'my-bucket' } } },
      failCreateRepo: true,
    });

    await expect(runSetup(client, defaultConfig())).rejects.toThrow('boom-create-repo');
  });
});

describe('settings shape', () => {
  it('writes provider/rotate_by/style/last_suffix from config and defaults for the rest', async () => {
    // rotate_by='bucket' + style='date' + year/month yields suffix=2026.05 and
    // new_bucket=my-bucket-2026.05; that bucket must be in use as a precondition.
    const { client, trace } = makeClient({
      existingSnapshotRepos: {
        other: { type: 'azure', settings: { container: 'my-bucket-2026.05' } },
      },
    });

    await runSetup(
      client,
      defaultConfig({
        provider: 'azure',
        rotate_by: 'bucket',
        style: 'date',
        year: 2026,
        month: 5,
      })
    );

    const doc = trace.settings_indexed?.document as Record<string, unknown>;
    expect(doc).toMatchObject({
      provider: 'azure',
      rotate_by: 'bucket',
      style: 'date',
      last_suffix: '2026.05',
      thaw_request_retention_days_completed:
        SETTINGS_DEFAULTS.thaw_request_retention_days_completed,
    });
  });
});
