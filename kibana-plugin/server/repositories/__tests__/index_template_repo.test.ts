import {
  indexTemplateExists,
  updateIndexTemplateIlmPolicy,
  type IndexTemplateEsClient,
} from '../index_template_repo';

interface FakeOpts {
  /** Map of template name → composable template doc (the inner index_template). */
  templates?: Record<string, Record<string, unknown>>;
  /** Map of legacy template name → legacy template body. */
  legacyTemplates?: Record<string, Record<string, unknown>>;
  capture?: (args: Record<string, unknown>) => void;
  /** Optional separate capture for legacy putTemplate calls. */
  captureLegacy?: (args: Record<string, unknown>) => void;
}

function notFound(): Error {
  const e: Error & { statusCode?: number; meta?: { statusCode: number } } = new Error('not found');
  e.statusCode = 404;
  e.meta = { statusCode: 404 };
  return e;
}

function makeClient(opts: FakeOpts = {}): IndexTemplateEsClient {
  return {
    indices: {
      getIndexTemplate: async ({ name }: { name?: string } = {}) => {
        if (name === undefined) {
          const items = Object.entries(opts.templates ?? {});
          return { index_templates: items.map(([n, t]) => ({ name: n, index_template: t })) };
        }
        const tmpl = opts.templates?.[name];
        if (!tmpl) throw notFound();
        return { index_templates: [{ name, index_template: tmpl }] };
      },
      putIndexTemplate: async (args) => {
        opts.capture?.(args);
        return {};
      },
      getTemplate: async ({ name }: { name?: string } = {}) => {
        if (name === undefined) return opts.legacyTemplates ?? {};
        const tmpl = opts.legacyTemplates?.[name];
        if (!tmpl) throw notFound();
        return { [name]: tmpl };
      },
      putTemplate: async (args) => {
        opts.captureLegacy?.(args);
        return {};
      },
    },
  };
}

describe('indexTemplateExists', () => {
  it('returns true when ES returns a populated index_templates array', async () => {
    const client = makeClient({ templates: { 't1': { index_patterns: ['x*'] } } });
    expect(await indexTemplateExists(client, 't1')).toBe(true);
  });

  it('returns false on 404', async () => {
    const client = makeClient({});
    expect(await indexTemplateExists(client, 'missing')).toBe(false);
  });
});

describe('updateIndexTemplateIlmPolicy', () => {
  it('rewrites lifecycle.name and PUTs only the allowed fields', async () => {
    const captured: Record<string, unknown>[] = [];
    const client = makeClient({
      templates: {
        'logs-template': {
          index_patterns: ['logs-*'],
          template: {
            settings: { index: { lifecycle: { name: 'old-policy' } } },
          },
          composed_of: ['logs-mappings'],
          priority: 100,
          // System-managed field that must NOT be sent back:
          created_date: '2024-01-01T00:00:00Z',
        },
      },
      capture: (args) => captured.push(args),
    });

    const result = await updateIndexTemplateIlmPolicy(client, 'logs-template', 'new-policy');

    expect(result).toEqual({
      action: 'updated',
      template_type: 'composable',
      old_policy: 'old-policy',
      new_policy: 'new-policy',
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({
      name: 'logs-template',
      body: {
        index_patterns: ['logs-*'],
        template: {
          settings: { index: { lifecycle: { name: 'new-policy' } } },
        },
        composed_of: ['logs-mappings'],
        priority: 100,
      },
    });
    expect((captured[0].body as Record<string, unknown>).created_date).toBeUndefined();
  });

  it('returns not_found on a missing template (no PUT)', async () => {
    const captured: Record<string, unknown>[] = [];
    const client = makeClient({ capture: (args) => captured.push(args) });

    const result = await updateIndexTemplateIlmPolicy(client, 'absent', 'p');
    expect(result.action).toBe('not_found');
    expect(captured).toHaveLength(0);
  });

  it('creates lifecycle scaffolding when the template has no settings yet', async () => {
    const captured: Record<string, unknown>[] = [];
    const client = makeClient({
      templates: {
        bare: { index_patterns: ['bare-*'] },
      },
      capture: (args) => captured.push(args),
    });

    await updateIndexTemplateIlmPolicy(client, 'bare', 'p');
    expect(captured[0]).toMatchObject({
      body: {
        template: { settings: { index: { lifecycle: { name: 'p' } } } },
      },
    });
  });

  it('auto-detects and updates a legacy template via PUT _template', async () => {
    const legacyCaptured: Record<string, unknown>[] = [];
    const composableCaptured: Record<string, unknown>[] = [];
    const client = makeClient({
      // Only legacy template exists by this name; composable lookup returns 404.
      legacyTemplates: {
        'df-test': {
          index_patterns: ['df-*'],
          order: 10,
          settings: { index: { lifecycle: { name: 'old' } } },
          mappings: { properties: { '@timestamp': { type: 'date' } } },
        },
      },
      capture: (a) => composableCaptured.push(a),
      captureLegacy: (a) => legacyCaptured.push(a),
    });

    const result = await updateIndexTemplateIlmPolicy(client, 'df-test', 'new-policy');

    expect(result).toMatchObject({
      action: 'updated',
      template_type: 'legacy',
      old_policy: 'old',
      new_policy: 'new-policy',
    });
    // Composable PUT not used; legacy PUT used with allowed fields only.
    expect(composableCaptured).toEqual([]);
    expect(legacyCaptured).toHaveLength(1);
    const body = legacyCaptured[0].body as Record<string, unknown>;
    // Legacy shape: settings at the root, not nested under `template`.
    expect(
      (
        ((body.settings as Record<string, unknown>).index as Record<string, unknown>)
          .lifecycle as { name: string }
      ).name
    ).toBe('new-policy');
    expect(body.index_patterns).toEqual(['df-*']);
    expect(body.order).toBe(10);
    expect(body.mappings).toBeDefined();
  });

  it('returns not_found when neither composable nor legacy template exists', async () => {
    const client = makeClient({});
    const result = await updateIndexTemplateIlmPolicy(client, 'missing', 'p');
    expect(result).toMatchObject({
      action: 'not_found',
      template_type: null,
      old_policy: 'none',
    });
  });
});
