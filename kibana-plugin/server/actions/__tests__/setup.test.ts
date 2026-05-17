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
  /** Existing ILM policies. */
  existingIlmPolicies?: Record<string, Record<string, unknown>>;
  /** Make `snapshot.createRepository` fail (e.g. bucket unreachable). */
  failCreateRepo?: boolean;
  /** Make `ilm.putLifecycle` fail. */
  failPutIlm?: boolean;
  /** Make `indices.putIndexTemplate` fail. */
  failPutTemplate?: boolean;
}

interface Trace {
  status_index_created?: boolean;
  audit_index_created?: boolean;
  settings_indexed?: Record<string, unknown>;
  repo_created?: Record<string, unknown>;
  ilm_put?: { name: string; policy: Record<string, unknown> };
  template_put?: { name: string; body: Record<string, unknown> };
}

function notFound(): Error {
  const e: Error & { statusCode?: number; meta?: { statusCode: number } } = new Error('nf');
  e.statusCode = 404;
  e.meta = { statusCode: 404 };
  return e;
}

function makeClient(opts: FakeOpts = {}): { client: SetupActionEsClient; trace: Trace } {
  const trace: Trace = {};

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
      getIndexTemplate: async ({ name }) => {
        const tmpl = opts.existingTemplates?.[name];
        if (!tmpl) throw notFound();
        return { index_templates: [{ name, index_template: tmpl }] };
      },
      putIndexTemplate: async (args) => {
        if (opts.failPutTemplate) throw new Error('boom-template');
        trace.template_put = args;
        return {};
      },
    },
    get: async () => ({ found: true }),
    index: async (args) => {
      trace.settings_indexed = args;
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
        if (!name) return opts.existingIlmPolicies ?? {};
        const p = opts.existingIlmPolicies?.[name];
        if (!p) throw notFound();
        return { [name]: p };
      },
      putLifecycle: async (args) => {
        if (opts.failPutIlm) throw new Error('boom-ilm');
        trace.ilm_put = args;
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
  it('returns buckets in use from existing snapshot repos', async () => {
    const { client } = makeClient({
      existingSnapshotRepos: {
        a: { type: 's3', settings: { bucket: 'b1', base_path: 'p1' } },
        b: { type: 's3', settings: { bucket: 'b2', base_path: 'p2' } },
      },
    });

    expect(await getSetupOptions(client)).toEqual({ buckets_in_use: ['b1', 'b2'] });
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
    expect(trace).toEqual({});
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

  it('creates a new ILM policy when configured and the policy did not exist', async () => {
    const { client, trace } = makeClient({
      existingSnapshotRepos: { other: { type: 's3', settings: { bucket: 'my-bucket' } } },
    });

    const result = await runSetup(client, defaultConfig({ ilm_policy_name: 'logs-policy' }));

    expect(result.errors).toEqual([]);
    expect(trace.ilm_put?.name).toBe('logs-policy');
    expect(result.steps.find((s) => s.type === 'ilm_policy')?.action).toBe('created');
  });

  it('updates a composable index template when configured', async () => {
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
