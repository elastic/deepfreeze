import {
  indexTemplateExists,
  updateIndexTemplateIlmPolicy,
  type IndexTemplateEsClient,
} from '../index_template_repo';

interface FakeOpts {
  /** Map of template name → composable template doc (the inner index_template). */
  templates?: Record<string, Record<string, unknown>>;
  capture?: (args: Record<string, unknown>) => void;
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
      getIndexTemplate: async ({ name }) => {
        const tmpl = opts.templates?.[name];
        if (!tmpl) throw notFound();
        return { index_templates: [{ name, index_template: tmpl }] };
      },
      putIndexTemplate: async (args) => {
        opts.capture?.(args);
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
});
