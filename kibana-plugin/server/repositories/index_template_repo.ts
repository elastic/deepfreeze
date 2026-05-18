/**
 * Index-template inspection and ILM-policy patching.
 *
 * Mirrors both composable and legacy-template branches of
 *   packages/deepfreeze-core/deepfreeze_core/utilities.py
 *     — update_index_template_ilm_policy()
 *
 * Legacy (pre-7.8) templates remain in production use even on 9.x
 * clusters; deepfreeze must be able to discover and rebind them too.
 * This module enumerates both kinds and auto-detects which API to use
 * when updating a template by name.
 */

/** Minimal structural interface for index-template operations (both kinds). */
export interface IndexTemplateEsClient {
  indices: {
    getIndexTemplate: (params: { name?: string }) => Promise<unknown>;
    putIndexTemplate: (params: { name: string; body: Record<string, unknown> }) => Promise<unknown>;
    /** Legacy templates: `GET /_template[/{name}]`. */
    getTemplate: (params?: { name?: string }) => Promise<unknown>;
    /** Legacy templates: `PUT /_template/{name}`. */
    putTemplate: (params: { name: string; body: Record<string, unknown> }) => Promise<unknown>;
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
  template_type: IndexTemplateKind | null;
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
 * Return every legacy (pre-7.8) template in the cluster as a
 * `{name, body}` list. ES emits these as `{ [name]: {...} }` — we flatten.
 *
 * 404 / no templates → empty list, same convention as composable.
 */
export async function getAllLegacyIndexTemplates(
  client: IndexTemplateEsClient
): Promise<Array<{ name: string; template: Record<string, unknown> }>> {
  try {
    const result = (await client.indices.getTemplate({})) as Record<
      string,
      Record<string, unknown>
    >;
    return Object.entries(result).map(([name, template]) => ({ name, template }));
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
}

/**
 * Return every index template name in the cluster (both composable and
 * legacy), deduped and sorted for stable display. Used by the Setup
 * wizard's dropdown.
 *
 * Legacy templates aren't tagged in the result — the binding code
 * detects which kind a name refers to via `resolveTemplateKind`.
 */
export async function getAllIndexTemplateNames(
  client: IndexTemplateEsClient
): Promise<string[]> {
  const [composable, legacy] = await Promise.all([
    getAllIndexTemplates(client),
    getAllLegacyIndexTemplates(client),
  ]);
  const names = new Set<string>();
  for (const t of composable) names.add(t.name);
  for (const t of legacy) names.add(t.name);
  return Array.from(names).sort();
}

/** Discriminator between composable and legacy templates. */
export type IndexTemplateKind = 'composable' | 'legacy';

/**
 * Determine whether a template name refers to a composable or legacy
 * template. Returns null if neither API knows about it.
 *
 * Composable wins when both exist with the same name (rare but
 * possible during migrations); composable is the modern API and ES
 * prefers it for new indices.
 */
export async function resolveTemplateKind(
  client: IndexTemplateEsClient,
  name: string
): Promise<IndexTemplateKind | null> {
  if (await indexTemplateExists(client, name)) return 'composable';
  try {
    const result = (await client.indices.getTemplate({ name })) as Record<
      string,
      unknown
    >;
    if (name in result) return 'legacy';
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  return null;
}

/**
 * Read the `settings.index.lifecycle.name` from a legacy template body.
 * Legacy templates put settings at the root, not nested under `template`
 * (which is the composable shape).
 */
function readLegacyTemplateIlmPolicy(
  templateData: Record<string, unknown>
): string | null {
  const settings = templateData.settings as Record<string, unknown> | undefined;
  const index = settings?.index as Record<string, unknown> | undefined;
  const lifecycle = index?.lifecycle as Record<string, unknown> | undefined;
  const name = lifecycle?.name;
  return typeof name === 'string' ? name : null;
}

/**
 * Return the names of every index template (composable or legacy)
 * whose ILM lifecycle binding equals `policyName`. Used by Rotate to
 * find which templates need to be repointed at the just-created
 * versioned ILM policy.
 */
export async function findTemplatesUsingPolicy(
  client: IndexTemplateEsClient,
  policyName: string
): Promise<string[]> {
  const matching: string[] = [];
  const [composable, legacy] = await Promise.all([
    getAllIndexTemplates(client),
    getAllLegacyIndexTemplates(client),
  ]);
  for (const entry of composable) {
    if (readTemplateIlmPolicy(entry.index_template) === policyName) {
      matching.push(entry.name);
    }
  }
  for (const entry of legacy) {
    if (readLegacyTemplateIlmPolicy(entry.template) === policyName) {
      matching.push(entry.name);
    }
  }
  return matching;
}

/**
 * Set `index.lifecycle.name` on the named index template, leaving
 * other fields untouched. Auto-detects whether the template is
 * composable or legacy and uses the appropriate API.
 *
 * Returns `not_found` if the template doesn't exist in either API.
 */
export async function updateIndexTemplateIlmPolicy(
  client: IndexTemplateEsClient,
  templateName: string,
  ilmPolicyName: string
): Promise<UpdateIndexTemplateResult> {
  const kind = await resolveTemplateKind(client, templateName);
  if (kind === null) {
    return {
      action: 'not_found',
      template_type: null,
      old_policy: 'none',
      new_policy: ilmPolicyName,
    };
  }
  if (kind === 'composable') {
    return updateComposableTemplateIlmPolicy(client, templateName, ilmPolicyName);
  }
  return updateLegacyTemplateIlmPolicy(client, templateName, ilmPolicyName);
}

async function updateComposableTemplateIlmPolicy(
  client: IndexTemplateEsClient,
  templateName: string,
  ilmPolicyName: string
): Promise<UpdateIndexTemplateResult> {
  const templates = (await client.indices.getIndexTemplate({
    name: templateName,
  })) as GetTemplateResponse;
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

  // Composable templates nest settings under `template.settings.index.lifecycle.name`.
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

/**
 * Fields the legacy `PUT _template/{name}` API accepts. Filter to
 * these to avoid sending system-managed fields back to ES.
 */
const LEGACY_TEMPLATE_FIELDS = [
  'index_patterns',
  'order',
  'version',
  'settings',
  'mappings',
  'aliases',
] as const;

async function updateLegacyTemplateIlmPolicy(
  client: IndexTemplateEsClient,
  templateName: string,
  ilmPolicyName: string
): Promise<UpdateIndexTemplateResult> {
  const result = (await client.indices.getTemplate({
    name: templateName,
  })) as Record<string, Record<string, unknown>>;
  const templateData = result[templateName];
  if (!templateData) {
    return {
      action: 'not_found',
      template_type: null,
      old_policy: 'none',
      new_policy: ilmPolicyName,
    };
  }

  // Legacy shape: settings at the root, not nested under `template`.
  const settings = (templateData.settings ??= {}) as Record<string, unknown>;
  const index = (settings.index ??= {}) as Record<string, unknown>;
  const lifecycle = (index.lifecycle ??= {}) as Record<string, unknown>;
  const oldPolicy = (lifecycle.name as string | undefined) ?? 'none';
  lifecycle.name = ilmPolicyName;

  const putBody: Record<string, unknown> = {};
  for (const field of LEGACY_TEMPLATE_FIELDS) {
    if (field in templateData) {
      putBody[field] = templateData[field];
    }
  }

  await client.indices.putTemplate({ name: templateName, body: putBody });

  return {
    action: 'updated',
    template_type: 'legacy',
    old_policy: oldPolicy,
    new_policy: ilmPolicyName,
  };
}
