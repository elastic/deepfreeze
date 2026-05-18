/**
 * Composable index-template inspection and ILM-policy patching.
 *
 * Mirrors the composable-template branches of
 *   packages/deepfreeze-core/deepfreeze_core/utilities.py
 *     — update_index_template_ilm_policy()
 *
 * Legacy (pre-7.8) templates are intentionally omitted: ES 9.x deprecated
 * legacy index templates and Kibana 9.4 only manages composable ones.
 */

/** Minimal structural interface for composable-template operations. */
export interface IndexTemplateEsClient {
  indices: {
    getIndexTemplate: (params: { name?: string }) => Promise<unknown>;
    putIndexTemplate: (params: { name: string; body: Record<string, unknown> }) => Promise<unknown>;
  };
}

interface GetTemplateResponse {
  index_templates?: Array<{
    name: string;
    index_template: Record<string, unknown>;
  }>;
}

/**
 * Fields the ES `PUT _index_template/{name}` API accepts. Mirrors the
 * `_COMPOSABLE_TEMPLATE_FIELDS` set in the Python implementation —
 * filtering the GET response down to these avoids sending system-managed
 * fields (e.g. `created_date`) back to ES, which 400s.
 */
const COMPOSABLE_TEMPLATE_FIELDS = [
  'index_patterns',
  'template',
  'composed_of',
  'priority',
  'version',
  '_meta',
  'data_stream',
  'allow_auto_create',
  'deprecated',
  'ignore_missing_component_templates',
] as const;

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { statusCode?: number; meta?: { statusCode?: number } };
  return e.statusCode === 404 || e.meta?.statusCode === 404;
}

/**
 * Return true if a composable template with this name exists.
 * False on 404; other errors propagate.
 */
export async function indexTemplateExists(
  client: IndexTemplateEsClient,
  name: string
): Promise<boolean> {
  try {
    const result = (await client.indices.getIndexTemplate({ name })) as GetTemplateResponse;
    return (result.index_templates?.length ?? 0) > 0;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

/**
 * Result type for `updateIndexTemplateIlmPolicy`. `updated` means we
 * issued a PUT; `not_found` means the template didn't exist.
 */
export interface UpdateIndexTemplateResult {
  action: 'updated' | 'not_found';
  template_type: 'composable' | null;
  old_policy: string;
  new_policy: string;
}

/**
 * Read the template's current `template.settings.index.lifecycle.name`.
 * Returns null if the template doesn't carry an ILM binding (or doesn't
 * exist). Used by `findTemplatesUsingPolicy` and exposed separately so
 * other callers can introspect template→policy bindings.
 */
export function readTemplateIlmPolicy(
  templateData: Record<string, unknown>
): string | null {
  const template = templateData.template as Record<string, unknown> | undefined;
  const settings = template?.settings as Record<string, unknown> | undefined;
  const index = settings?.index as Record<string, unknown> | undefined;
  const lifecycle = index?.lifecycle as Record<string, unknown> | undefined;
  const name = lifecycle?.name;
  return typeof name === 'string' ? name : null;
}

/**
 * Fetch every composable index template. Returns the list in the
 * `index_templates: [{name, index_template}]` shape ES emits.
 *
 * 404 from ES (e.g. no templates at all on a fresh cluster) is treated
 * as an empty list — same convention as the rest of this repo layer.
 */
export async function getAllIndexTemplates(
  client: IndexTemplateEsClient
): Promise<Array<{ name: string; index_template: Record<string, unknown> }>> {
  try {
    const result = (await client.indices.getIndexTemplate({})) as GetTemplateResponse;
    return result.index_templates ?? [];
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
}

/**
 * Return the names of every composable template whose
 * `template.settings.index.lifecycle.name` equals `policyName`. Used by
 * Rotate to find which templates need to be repointed at the
 * just-created versioned ILM policy.
 */
export async function findTemplatesUsingPolicy(
  client: IndexTemplateEsClient,
  policyName: string
): Promise<string[]> {
  const all = await getAllIndexTemplates(client);
  const matching: string[] = [];
  for (const entry of all) {
    const bound = readTemplateIlmPolicy(entry.index_template);
    if (bound === policyName) {
      matching.push(entry.name);
    }
  }
  return matching;
}

/**
 * Set `template.settings.index.lifecycle.name` on the named composable
 * template, leaving other fields untouched. Returns `not_found` if the
 * template doesn't exist (the caller decides whether that's a warning
 * or an error).
 */
export async function updateIndexTemplateIlmPolicy(
  client: IndexTemplateEsClient,
  templateName: string,
  ilmPolicyName: string
): Promise<UpdateIndexTemplateResult> {
  let templates: GetTemplateResponse;
  try {
    templates = (await client.indices.getIndexTemplate({
      name: templateName,
    })) as GetTemplateResponse;
  } catch (err) {
    if (isNotFound(err)) {
      return {
        action: 'not_found',
        template_type: null,
        old_policy: 'none',
        new_policy: ilmPolicyName,
      };
    }
    throw err;
  }

  const entry = templates.index_templates?.[0];
  if (!entry) {
    return {
      action: 'not_found',
      template_type: null,
      old_policy: 'none',
      new_policy: ilmPolicyName,
    };
  }

  const templateData = entry.index_template as Record<string, unknown>;

  // Build the nested settings path, creating intermediate objects as needed.
  const template = (templateData.template ??= {}) as Record<string, unknown>;
  const settings = (template.settings ??= {}) as Record<string, unknown>;
  const index = (settings.index ??= {}) as Record<string, unknown>;
  const lifecycle = (index.lifecycle ??= {}) as Record<string, unknown>;
  const oldPolicy = (lifecycle.name as string | undefined) ?? 'none';
  lifecycle.name = ilmPolicyName;

  const putBody: Record<string, unknown> = {};
  for (const field of COMPOSABLE_TEMPLATE_FIELDS) {
    if (field in templateData) {
      putBody[field] = templateData[field];
    }
  }

  await client.indices.putIndexTemplate({ name: templateName, body: putBody });

  return {
    action: 'updated',
    template_type: 'composable',
    old_policy: oldPolicy,
    new_policy: ilmPolicyName,
  };
}
