/**
 * Setup action — initialize deepfreeze in a cluster.
 *
 * Mirrors `Setup.do_action` in
 *   packages/deepfreeze-core/deepfreeze_core/actions/setup.py
 * with one architectural divergence (see project_phase2_setup_design.md):
 *
 *   The Kibana plugin does NOT create cloud buckets. The bucket must
 *   already exist; the wizard picks from buckets already in use by
 *   other snapshot repositories. Setup creates the ES-side state only:
 *   audit + status indices, the settings doc, the new snapshot
 *   repository, and optionally the ILM policy + index-template update.
 *
 * ILM policy lifecycle:
 *   The user-selected base ILM policy is NEVER modified in place. If
 *   it doesn't exist yet, Setup creates it from the default tiering
 *   strategy (one-time, write-once). It then clones the base body to
 *   produce `<base>-<suffix>` (the first versioned policy) pointing at
 *   the first repo. The index template is bound to the versioned name,
 *   not the base, so future Rotate calls can keep producing new
 *   versioned policies without ever touching the user's base. Mirrors
 *   the per-rotation versioning seen in rotate.ts.
 */

import type { Provider } from '../../common/constants';
import { SETTINGS_DEFAULTS, type SettingsDoc } from '../../common/schemas/settings';
import { STATUS_INDEX } from '../../common/constants';
import type { ServiceError } from '../../common/types/errors';
import { ActionError, PreconditionError } from '../errors';
import { ensureAuditIndex, ensureStatusIndex, type IndexAwareEsClient } from '../es/index_bootstrap';
import {
  saveSettings,
  type SettingsRepoWriteEsClient,
} from '../repositories/settings_repo';
import {
  saveRepositoryDoc,
  type RepositoryRepoWriteEsClient,
} from '../repositories/repository_repo';
import type { RepositoryDoc } from '../../common/schemas/repository';
import {
  createVersionedIlmPolicy,
  defaultIlmPolicyBody,
  getAllIlmPolicyNames,
  getIlmPolicy,
  type IlmRepoWriteEsClient,
} from '../repositories/ilm_repo';
import {
  getAllIndexTemplateNames,
  indexTemplateExists,
  updateIndexTemplateIlmPolicy,
  type IndexTemplateEsClient,
  type UpdateIndexTemplateResult,
} from '../repositories/index_template_repo';
import {
  createSnapshotRepository,
  getBucketsInUse,
  getReposMatchingPrefix,
  isBucketBasePathInUse,
  type SnapshotRepoEsClient,
} from '../repositories/snapshot_repo';

/**
 * Full ES surface required by the setup action.
 *
 * Declared as an intersection of the sub-client interfaces so the
 * compiler merges their `indices` namespaces (each contributes
 * different methods) instead of failing on the property collision
 * that would happen with `extends`.
 */
export type SetupActionEsClient = SettingsRepoWriteEsClient &
  IlmRepoWriteEsClient &
  SnapshotRepoEsClient &
  RepositoryRepoWriteEsClient & {
    indices: IndexAwareEsClient['indices'] & IndexTemplateEsClient['indices'];
  };

/**
 * Input shape for `runSetup`. Matches the Python `Setup.__init__`
 * params one-for-one, minus the rich-console flags.
 */
export interface SetupConfig {
  repo_name_prefix: string;
  bucket_name_prefix: string;
  base_path_prefix: string;
  canned_acl: string;
  storage_class: string;
  provider: Provider;
  rotate_by: 'path' | 'bucket';
  style: 'oneup' | 'date';
  /** Required when `style === 'date'`; ignored otherwise. */
  year?: number;
  /** Required when `style === 'date'`; ignored otherwise. */
  month?: number;
  /** When set, create/update the named ILM policy to target the new repo. */
  ilm_policy_name?: string;
  /** When set, retarget the named index template at `ilm_policy_name`. */
  index_template_name?: string;
}

export interface RunSetupOptions {
  log?: { debug: (m: string) => void; warn: (m: string) => void };
}

const NOOP_LOG = { debug: () => {}, warn: () => {} };

/** Per-step record of what `runSetup` did. */
export interface SetupStepRecord {
  type:
    | 'status_index'
    | 'audit_index'
    | 'settings'
    | 'snapshot_repository'
    | 'ilm_policy'
    | 'index_template';
  action: 'would_create' | 'would_update' | 'created' | 'updated' | 'unchanged' | 'not_found' | 'skipped';
  name?: string;
  detail?: string;
}

/**
 * Return shape of `runSetup` / `runSetupDryRun`. Mirrors the per-action
 * `CommandResult` of the Python FastAPI server.
 */
export interface SetupResult {
  success: boolean;
  dry_run: boolean;
  settings: SettingsDoc;
  new_repo_name: string;
  new_bucket: string;
  new_base_path: string;
  steps: SetupStepRecord[];
  errors: ServiceError[];
  started_at: string;
  completed_at: string;
}

/**
 * Available choices for the wizard's bucket, ILM policy, and index
 * template dropdowns. Any list may be empty on a fresh cluster — the
 * wizard surfaces that to the user as a callout where it matters.
 *
 * `ilm_policy_names` allows the wizard to combine "pick an existing
 * policy" with "type a new name" (the latter triggers Setup's
 * create-from-default-body path). `index_template_names` is dropdown-
 * only because Setup never creates templates — it only rebinds them.
 */
export interface SetupOptions {
  buckets_in_use: string[];
  ilm_policy_names: string[];
  index_template_names: string[];
}

/** Helpers exposed for the wizard's pre-flight dropdowns. */
export async function getSetupOptions(
  client: SnapshotRepoEsClient & IlmRepoWriteEsClient & IndexTemplateEsClient
): Promise<SetupOptions> {
  const buckets_in_use = await getBucketsInUse(client);
  const ilm_policy_names = await getAllIlmPolicyNames(client);
  const index_template_names = await getAllIndexTemplateNames(client);
  return { buckets_in_use, ilm_policy_names, index_template_names };
}

/** Compute the suffix used in repo/base_path naming for this setup. */
export function computeSuffix(config: Pick<SetupConfig, 'style' | 'year' | 'month'>): string {
  if (config.style === 'date') {
    if (config.year === undefined || config.month === undefined) {
      throw new ActionError("style='date' requires 'year' and 'month'");
    }
    return `${String(config.year).padStart(4, '0')}.${String(config.month).padStart(2, '0')}`;
  }
  return '000001';
}

/**
 * Resolved naming for a setup run. Pure function — no ES calls.
 *
 * - rotate_by='path' (default): one shared bucket, base_path includes the suffix.
 * - rotate_by='bucket': one bucket per rotation; base_path is the bare prefix.
 *
 * Both variants are computed identically to Python's `Setup.__init__`.
 */
export interface ResolvedNaming {
  suffix: string;
  new_repo_name: string;
  new_bucket: string;
  new_base_path: string;
}

export function resolveNaming(config: SetupConfig): ResolvedNaming {
  const suffix = computeSuffix(config);
  const new_repo_name = `${config.repo_name_prefix}-${suffix}`;

  let new_bucket: string;
  let new_base_path: string;
  if (config.rotate_by === 'bucket') {
    new_bucket = `${config.bucket_name_prefix}-${suffix}`;
    new_base_path = config.base_path_prefix;
  } else {
    new_bucket = config.bucket_name_prefix;
    new_base_path = `${config.base_path_prefix}-${suffix}`;
  }

  return { suffix, new_repo_name, new_bucket, new_base_path };
}

/**
 * Verify everything that has to be true before we touch the cluster:
 *   1. Status index does not already exist.
 *   2. No existing snapshot repos match `repo_name_prefix`.
 *   3. The chosen bucket already exists (i.e. is in use by another repo).
 *   4. The chosen bucket+base_path combo is not already in use.
 *   5. If a `index_template_name` is provided, it exists.
 *
 * Throws `PreconditionError` with one `issues` entry per failed check.
 */
async function checkPreconditions(
  client: SetupActionEsClient,
  config: SetupConfig,
  naming: ResolvedNaming
): Promise<void> {
  const issues: string[] = [];

  const statusExists = await client.indices.exists({ index: STATUS_INDEX });
  if (statusExists) {
    issues.push(
      `Status index "${STATUS_INDEX}" already exists. Delete it and rerun setup, ` +
        'or restore from an existing deepfreeze configuration.'
    );
  }

  const conflictingRepos = await getReposMatchingPrefix(client, config.repo_name_prefix);
  if (conflictingRepos.length > 0) {
    issues.push(
      `Found ${conflictingRepos.length} existing snapshot repositor${
        conflictingRepos.length === 1 ? 'y' : 'ies'
      } matching prefix "${config.repo_name_prefix}": ${conflictingRepos.join(', ')}. ` +
        'Choose a different prefix or remove the existing repositories.'
    );
  }

  const bucketsInUse = await getBucketsInUse(client);
  if (!bucketsInUse.includes(naming.new_bucket)) {
    issues.push(
      `Bucket "${naming.new_bucket}" is not in use by any existing snapshot repository. ` +
        'Deepfreeze does not create buckets — pick one already configured on this cluster ' +
        `or pre-create it externally. Available buckets: ${
          bucketsInUse.length > 0 ? bucketsInUse.join(', ') : '(none)'
        }.`
    );
  } else if (await isBucketBasePathInUse(client, naming.new_bucket, naming.new_base_path)) {
    issues.push(
      `Storage location ${naming.new_bucket}/${naming.new_base_path} is already in use by ` +
        'another snapshot repository. Pick a different base path.'
    );
  }

  if (config.index_template_name) {
    const exists = await indexTemplateExists(client, config.index_template_name);
    if (!exists) {
      issues.push(
        `Composable index template "${config.index_template_name}" does not exist. ` +
          'Create the template first, or leave the field blank to skip template configuration.'
      );
    }
  }

  if (issues.length > 0) {
    throw new PreconditionError(
      `${issues.length} setup precondition${issues.length === 1 ? '' : 's'} failed`,
      issues
    );
  }
}

/** Materialize a SettingsDoc from a SetupConfig + resolved naming. */
function settingsFromConfig(config: SetupConfig, naming: ResolvedNaming): SettingsDoc {
  return {
    ...SETTINGS_DEFAULTS,
    repo_name_prefix: config.repo_name_prefix,
    bucket_name_prefix: config.bucket_name_prefix,
    base_path_prefix: config.base_path_prefix,
    canned_acl: config.canned_acl,
    storage_class: config.storage_class,
    provider: config.provider,
    rotate_by: config.rotate_by,
    style: config.style,
    last_suffix: naming.suffix,
    ilm_policy_name: config.ilm_policy_name ?? null,
    index_template_name: config.index_template_name ?? null,
  };
}

/**
 * Validate that setup *would* succeed without making any cluster changes.
 *
 * Runs preconditions, then enumerates the steps Setup would take so the
 * UI can preview them. Throws `PreconditionError` on a precondition
 * failure; never throws on success.
 */
export async function runSetupDryRun(
  client: SetupActionEsClient,
  config: SetupConfig
): Promise<SetupResult> {
  const started_at = new Date().toISOString();
  const naming = resolveNaming(config);

  await checkPreconditions(client, config, naming);

  const steps: SetupStepRecord[] = [
    { type: 'status_index', action: 'would_create', name: STATUS_INDEX },
    { type: 'audit_index', action: 'would_create' },
    { type: 'settings', action: 'would_create' },
    {
      type: 'snapshot_repository',
      action: 'would_create',
      name: naming.new_repo_name,
      detail: `${naming.new_bucket}/${naming.new_base_path}`,
    },
  ];
  if (config.ilm_policy_name) {
    const versioned = `${config.ilm_policy_name}-${naming.suffix}`;
    steps.push({
      type: 'ilm_policy',
      action: 'would_create',
      name: versioned,
      detail: `cloned from ${config.ilm_policy_name}, → ${naming.new_repo_name}`,
    });
  }
  if (config.index_template_name) {
    const versioned = config.ilm_policy_name
      ? `${config.ilm_policy_name}-${naming.suffix}`
      : '';
    steps.push({
      type: 'index_template',
      action: 'would_update',
      name: config.index_template_name,
      detail: versioned ? `→ ${versioned}` : undefined,
    });
  }

  return {
    success: true,
    dry_run: true,
    settings: settingsFromConfig(config, naming),
    new_repo_name: naming.new_repo_name,
    new_bucket: naming.new_bucket,
    new_base_path: naming.new_base_path,
    steps,
    errors: [],
    started_at,
    completed_at: new Date().toISOString(),
  };
}

/**
 * Run the full setup: preconditions, then six writes (status index,
 * audit index, settings doc, snapshot repository, optional ILM policy,
 * optional template). Non-critical step failures (ILM and template
 * stages) degrade to warnings in `errors[]` rather than aborting,
 * matching the Python implementation's "best effort after the
 * repository is registered" behavior.
 */
export async function runSetup(
  client: SetupActionEsClient,
  config: SetupConfig,
  options: RunSetupOptions = {}
): Promise<SetupResult> {
  const log = options.log ?? NOOP_LOG;
  const started_at = new Date().toISOString();
  const naming = resolveNaming(config);

  await checkPreconditions(client, config, naming);

  const steps: SetupStepRecord[] = [];
  const errors: ServiceError[] = [];

  const statusResult = await ensureStatusIndex(client);
  steps.push({
    type: 'status_index',
    action: statusResult === 'created' ? 'created' : 'unchanged',
    name: STATUS_INDEX,
  });

  const auditResult = await ensureAuditIndex(client);
  steps.push({
    type: 'audit_index',
    action: auditResult === 'created' ? 'created' : 'unchanged',
  });

  const settings = settingsFromConfig(config, naming);
  await saveSettings(client, settings);
  steps.push({ type: 'settings', action: 'created' });

  await createSnapshotRepository(client, {
    name: naming.new_repo_name,
    provider: config.provider,
    bucket: naming.new_bucket,
    base_path: naming.new_base_path,
    canned_acl: config.canned_acl,
    storage_class: config.storage_class,
  });
  steps.push({
    type: 'snapshot_repository',
    action: 'created',
    name: naming.new_repo_name,
    detail: `${naming.new_bucket}/${naming.new_base_path}`,
  });

  const newRepoDoc: RepositoryDoc = {
    doctype: 'repository',
    name: naming.new_repo_name,
    bucket: naming.new_bucket,
    base_path: naming.new_base_path,
    start: null,
    end: null,
    is_thawed: false,
    is_mounted: true,
    thaw_state: 'active',
    thawed_at: null,
    expires_at: null,
  };
  await saveRepositoryDoc(client, newRepoDoc);

  // ILM policy: NEVER mutate the user-selected base policy in place.
  // Setup creates the first versioned policy `<base>-<suffix>` (where
  // <suffix> matches the first repo, e.g. `-000001`) and points the
  // index template at that versioned name. The base policy stays
  // untouched as the stable source-of-truth for future Rotate calls.
  // If the user-selected base policy doesn't yet exist, create it from
  // the default deepfreeze tiering strategy first — then clone it to
  // produce the versioned copy.
  const versionedPolicyName = config.ilm_policy_name
    ? `${config.ilm_policy_name}-${naming.suffix}`
    : null;

  if (config.ilm_policy_name) {
    try {
      let baseBody: { phases?: Record<string, unknown> } | null = null;
      const existing = await getIlmPolicy(client, config.ilm_policy_name);
      if (existing?.policy) {
        baseBody = existing.policy as { phases?: Record<string, unknown> };
        steps.push({
          type: 'ilm_policy',
          action: 'unchanged',
          name: config.ilm_policy_name,
          detail: 'base policy left as-is',
        });
      } else {
        // No base policy yet — create one from the default tiering
        // strategy. This is the one and only time Setup writes to the
        // base name; subsequent rotations only touch versioned copies.
        baseBody = defaultIlmPolicyBody(naming.new_repo_name);
        await client.ilm.putLifecycle({
          name: config.ilm_policy_name,
          policy: baseBody,
        });
        steps.push({
          type: 'ilm_policy',
          action: 'created',
          name: config.ilm_policy_name,
          detail: 'base policy created from default tiering strategy',
        });
      }

      // Create the first versioned policy `<base>-<suffix>`.
      await createVersionedIlmPolicy(
        client,
        config.ilm_policy_name,
        baseBody,
        naming.new_repo_name,
        naming.suffix
      );
      steps.push({
        type: 'ilm_policy',
        action: 'created',
        name: versionedPolicyName!,
        detail: `cloned from ${config.ilm_policy_name}, → ${naming.new_repo_name}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Failed to manage ILM policy ${config.ilm_policy_name}: ${msg}`);
      errors.push({
        code: 'ACTION_FAILED',
        message: `Failed to manage ILM policy ${config.ilm_policy_name}: ${msg}`,
        severity: 'warning',
        target: config.ilm_policy_name,
      });
    }
  }

  let templateResult: UpdateIndexTemplateResult | null = null;
  if (config.index_template_name) {
    try {
      // Point the template at the versioned policy (not the base), so
      // new indices created post-setup bind to `<base>-<suffix>` and
      // future rotations rebind only the versioned name, leaving the
      // base policy permanently stable.
      templateResult = await updateIndexTemplateIlmPolicy(
        client,
        config.index_template_name,
        versionedPolicyName ?? config.ilm_policy_name ?? ''
      );
      steps.push({
        type: 'index_template',
        action: templateResult.action,
        name: config.index_template_name,
        detail:
          templateResult.action === 'updated'
            ? `${templateResult.old_policy} → ${templateResult.new_policy}`
            : undefined,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Failed to update index template ${config.index_template_name}: ${msg}`);
      errors.push({
        code: 'ACTION_FAILED',
        message: `Failed to update index template ${config.index_template_name}: ${msg}`,
        severity: 'warning',
        target: config.index_template_name,
      });
    }
  }

  return {
    success: true,
    dry_run: false,
    settings,
    new_repo_name: naming.new_repo_name,
    new_bucket: naming.new_bucket,
    new_base_path: naming.new_base_path,
    steps,
    errors,
    started_at,
    completed_at: new Date().toISOString(),
  };
}
