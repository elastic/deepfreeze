/**
 * Rotate action — create the next-suffix snapshot repository, create a
 * versioned ILM policy pointing at it, retarget index templates onto
 * that new versioned policy, and unmount older repositories that fall
 * outside the `keep` window.
 *
 * Mirrors `Rotate.do_action` in
 *   packages/deepfreeze-core/deepfreeze_core/actions/rotate.py
 * with two deliberate simplifications for the Kibana port:
 *
 *   1. **rotate_by='bucket' is unsupported.** Bucket-rotation needs the
 *      storage SDK (deferred to Phase 4). If `settings.rotate_by` is
 *      `'bucket'` we throw `NotSupportedError`. The wizard locks
 *      rotate_by to `'path'` so this only fires for clusters set up
 *      via the Python CLI.
 *   2. **No `push_to_glacier`.** That requires the storage SDK too.
 *      Bucket lifecycle policies (set externally) handle archival.
 *
 * Versioned ILM policy lifecycle:
 *   - Setup creates the base policy `<ilm_policy_name>` pointing at the
 *     first repo.
 *   - First rotation: read the base policy, create `<base>-<new_suffix>`
 *     pointing at the new repo, repoint any templates currently
 *     referencing `<base>` to the new versioned name.
 *   - Nth rotation: read `<base>-<old_suffix>` (or fall back to base if
 *     missing), create `<base>-<new_suffix>` pointing at the new repo,
 *     repoint templates currently referencing `<base>-<old_suffix>`.
 *   - Old versioned policies stay alive so indices already bound to
 *     them keep snapshotting to their original repo. Orphaned versioned
 *     policies (no indices/data-streams/templates left) get reaped by
 *     Cleanup — see cleanup.ts for the (still pending) implementation.
 */

import type { ServiceError } from '../../common/types/errors';
import type { RepositoryDoc } from '../../common/schemas/repository';
import type { SettingsDoc } from '../../common/schemas/settings';
import { ActionError, MissingIndexError, MissingSettingsError } from '../errors';
import {
  getSettings,
  saveSettings,
  type SettingsRepoWriteEsClient,
} from '../repositories/settings_repo';
import {
  getAllRepos,
  saveRepositoryDoc,
  type RepositoryRepoWriteEsClient,
} from '../repositories/repository_repo';
import {
  createSnapshotRepository,
  deleteSnapshotRepository,
  type SnapshotRepoEsClient,
} from '../repositories/snapshot_repo';
import {
  createVersionedIlmPolicy,
  getIlmPolicy,
  type IlmRepoWriteEsClient,
} from '../repositories/ilm_repo';
import {
  findTemplatesUsingPolicy,
  updateIndexTemplateIlmPolicy,
  type IndexTemplateEsClient,
} from '../repositories/index_template_repo';

/** Full ES surface required by `runRotate`. */
export type RotateActionEsClient = SettingsRepoWriteEsClient &
  RepositoryRepoWriteEsClient &
  SnapshotRepoEsClient &
  IlmRepoWriteEsClient &
  IndexTemplateEsClient;

export interface RotateConfig {
  /** Number of newest active repositories to keep mounted. Defaults to 1. */
  keep?: number;
  /** Required when `settings.style === 'date'`; otherwise ignored. */
  year?: number;
  /** Required when `settings.style === 'date'`; otherwise ignored. */
  month?: number;
}

export interface RunRotateOptions {
  log?: { debug: (m: string) => void; warn: (m: string) => void };
}

const NOOP_LOG = { debug: () => {}, warn: () => {} };

export interface RotateStepRecord {
  type:
    | 'snapshot_repository'
    | 'settings'
    | 'repository_doc'
    | 'ilm_policy'
    | 'index_template';
  action:
    | 'would_create'
    | 'would_update'
    | 'would_archive'
    | 'created'
    | 'updated'
    | 'unchanged'
    | 'archived'
    | 'skipped';
  name?: string;
  detail?: string;
}

export interface RotateResult {
  success: boolean;
  dry_run: boolean;
  new_repo_name: string;
  new_bucket: string;
  new_base_path: string;
  /** Repos that were (or would be) unmounted and flipped to frozen. */
  archived: string[];
  /** Repos we wanted to archive but couldn't (active indices, etc.). */
  skipped: string[];
  steps: RotateStepRecord[];
  errors: ServiceError[];
  started_at: string;
  completed_at: string;
}

/**
 * Compute the suffix the next rotation will use.
 *
 *   - oneup: numeric increment of `last_suffix`, zero-padded to 6 digits.
 *   - date:  `YYYY.MM`.
 *
 * Mirrors `get_next_suffix` in the Python utilities.
 */
export function getNextSuffix(
  style: SettingsDoc['style'],
  last_suffix: string | null,
  year?: number,
  month?: number
): string {
  if (style === 'date') {
    const y = year ?? new Date().getUTCFullYear();
    const m = month ?? new Date().getUTCMonth() + 1;
    if (m < 1 || m > 12) throw new ActionError(`Invalid month: ${m}`);
    return `${String(y).padStart(4, '0')}.${String(m).padStart(2, '0')}`;
  }

  // oneup
  const current = Number.parseInt(last_suffix ?? '0', 10);
  if (Number.isNaN(current)) {
    throw new ActionError(
      `Invalid last_suffix for oneup style: "${last_suffix}" — must be numeric`
    );
  }
  return String(current + 1).padStart(6, '0');
}

interface ResolvedRotation {
  next_suffix: string;
  new_repo_name: string;
  new_bucket: string;
  new_base_path: string;
}

function resolveRotation(
  settings: SettingsDoc,
  config: RotateConfig
): ResolvedRotation {
  const next_suffix = getNextSuffix(
    settings.style,
    settings.last_suffix,
    config.year,
    config.month
  );
  const new_repo_name = `${settings.repo_name_prefix}-${next_suffix}`;
  // rotate_by='bucket' is guarded against upstream; here it's always 'path'.
  const new_bucket = settings.bucket_name_prefix;
  const new_base_path = `${settings.base_path_prefix}-${next_suffix}`;
  return { next_suffix, new_repo_name, new_bucket, new_base_path };
}

/**
 * Load settings or throw the appropriate domain error. Distinct helper
 * so dry-run and real-run share the same error path.
 */
async function loadInitializedSettings(client: RotateActionEsClient): Promise<SettingsDoc> {
  let settings: SettingsDoc | null;
  try {
    settings = await getSettings(client);
  } catch (err) {
    if (err instanceof MissingIndexError) throw err;
    throw err;
  }
  if (!settings) {
    throw new MissingSettingsError('Settings document not found in status index');
  }
  if (settings.rotate_by === 'bucket') {
    throw new ActionError(
      'Bucket rotation is not supported by the Kibana plugin (storage adapters land in Phase 4). ' +
        "Reset settings.rotate_by to 'path' to rotate via the plugin."
    );
  }
  return settings;
}

/**
 * Build the would-be RotateResult for dry-run. Does not call any write
 * methods; only reads settings and existing Repository docs.
 */
export async function runRotateDryRun(
  client: RotateActionEsClient,
  config: RotateConfig = {}
): Promise<RotateResult> {
  const started_at = new Date().toISOString();
  const settings = await loadInitializedSettings(client);
  const resolved = resolveRotation(settings, config);

  const keep = config.keep ?? 1;
  const { archived, skipped } = await pickReposToArchive(client, settings, keep);

  const steps: RotateStepRecord[] = [
    {
      type: 'snapshot_repository',
      action: 'would_create',
      name: resolved.new_repo_name,
      detail: `${resolved.new_bucket}/${resolved.new_base_path}`,
    },
    { type: 'repository_doc', action: 'would_create', name: resolved.new_repo_name },
    { type: 'settings', action: 'would_update', detail: `last_suffix → ${resolved.next_suffix}` },
  ];
  if (settings.ilm_policy_name) {
    const oldSuffix = settings.last_suffix;
    const newVersioned = `${settings.ilm_policy_name}-${resolved.next_suffix}`;
    const sourceName = oldSuffix
      ? `${settings.ilm_policy_name}-${oldSuffix}`
      : settings.ilm_policy_name;
    steps.push({
      type: 'ilm_policy',
      action: 'would_create',
      name: newVersioned,
      detail: `cloned from ${sourceName}, → ${resolved.new_repo_name}`,
    });
    // We can't enumerate templates here without an extra ES round-trip
    // in dry-run; surface the prospective rebind generically. The real
    // run reports per-template details.
    steps.push({
      type: 'index_template',
      action: 'would_update',
      detail: `templates bound to ${sourceName} → ${newVersioned}`,
    });
  }
  for (const r of archived) {
    steps.push({ type: 'snapshot_repository', action: 'would_archive', name: r });
  }

  return {
    success: true,
    dry_run: true,
    new_repo_name: resolved.new_repo_name,
    new_bucket: resolved.new_bucket,
    new_base_path: resolved.new_base_path,
    archived,
    skipped,
    steps,
    errors: [],
    started_at,
    completed_at: new Date().toISOString(),
  };
}

/**
 * Versioned ILM policy creation + template rebind, as a single atomic
 * step. Step failures within this block degrade to warnings on
 * `errors[]` so they don't abort the larger rotation.
 *
 * Read order:
 *   1. Try `<base>-<oldSuffix>` (the most recent versioned policy);
 *      this preserves any operator edits made since the last rotation.
 *   2. Fall back to the base `<base>` policy on first rotation.
 *   3. If neither exists, log a warning and skip ILM work entirely —
 *      matches Python's behaviour when the configured policy is absent.
 */
async function rotateVersionedIlmPolicy(params: {
  client: RotateActionEsClient;
  basePolicyName: string;
  oldSuffix: string | null;
  newSuffix: string;
  newRepoName: string;
  steps: RotateStepRecord[];
  errors: ServiceError[];
  log: { debug: (m: string) => void; warn: (m: string) => void };
}): Promise<void> {
  const { client, basePolicyName, oldSuffix, newSuffix, newRepoName, steps, errors, log } =
    params;
  const newPolicyName = `${basePolicyName}-${newSuffix}`;
  const oldVersionedName = oldSuffix ? `${basePolicyName}-${oldSuffix}` : null;

  // Resolve the source policy: prefer the most recent versioned copy.
  let sourceName: string | null = null;
  let sourceBody: { phases?: Record<string, unknown> } | null = null;
  if (oldVersionedName) {
    const candidate = await getIlmPolicy(client, oldVersionedName);
    if (candidate?.policy) {
      sourceName = oldVersionedName;
      sourceBody = candidate.policy as { phases?: Record<string, unknown> };
    }
  }
  if (!sourceBody) {
    const base = await getIlmPolicy(client, basePolicyName);
    if (base?.policy) {
      sourceName = basePolicyName;
      sourceBody = base.policy as { phases?: Record<string, unknown> };
    }
  }
  if (!sourceBody || !sourceName) {
    log.warn(
      `ILM policy ${basePolicyName} not found; skipping versioned-policy creation. ` +
        'New indices will be created without a deepfreeze ILM binding until the policy is restored.'
    );
    errors.push({
      code: 'ACTION_FAILED',
      message: `ILM policy ${basePolicyName} not found; versioned policy not created.`,
      severity: 'warning',
      target: basePolicyName,
    });
    return;
  }

  // Step 1: create the new versioned policy.
  try {
    await createVersionedIlmPolicy(
      client,
      basePolicyName,
      sourceBody,
      newRepoName,
      newSuffix
    );
    steps.push({
      type: 'ilm_policy',
      action: 'created',
      name: newPolicyName,
      detail: `cloned from ${sourceName}, → ${newRepoName}`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Failed to create versioned ILM policy ${newPolicyName}: ${msg}`);
    errors.push({
      code: 'ACTION_FAILED',
      message: `Failed to create versioned ILM policy ${newPolicyName}: ${msg}`,
      severity: 'warning',
      target: newPolicyName,
    });
    return;
  }

  // Step 2: find every composable template currently bound to the old
  // policy (either the previous versioned name or the base, depending
  // on whether this is the first rotation) and repoint them.
  try {
    const toUpdate = await findTemplatesUsingPolicy(client, sourceName);
    if (toUpdate.length === 0) {
      log.debug(`No index templates currently bound to ${sourceName}`);
      return;
    }
    for (const templateName of toUpdate) {
      try {
        const result = await updateIndexTemplateIlmPolicy(
          client,
          templateName,
          newPolicyName
        );
        if (result.action === 'updated') {
          steps.push({
            type: 'index_template',
            action: 'updated',
            name: templateName,
            detail: `${sourceName} → ${newPolicyName}`,
          });
        } else {
          steps.push({
            type: 'index_template',
            action: 'skipped',
            name: templateName,
            detail: 'template no longer exists',
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`Failed to update template ${templateName}: ${msg}`);
        errors.push({
          code: 'ACTION_FAILED',
          message: `Failed to update template ${templateName}: ${msg}`,
          severity: 'warning',
          target: templateName,
        });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Failed to enumerate templates for rebind: ${msg}`);
    errors.push({
      code: 'ACTION_FAILED',
      message: `Failed to enumerate templates for rebind: ${msg}`,
      severity: 'warning',
      target: sourceName,
    });
  }
}

/**
 * Decide which currently-active repos should be archived this rotation.
 *
 * The thaw lifecycle (thawing / thawed / expired) is owned by Thaw and
 * Refreeze, so we explicitly skip those states — they shouldn't count
 * against `keep` and they shouldn't get unmounted by rotation.
 *
 * Sort is by name (suffix-encoded so lexicographic = chronological for
 * both oneup and date styles); the newest `keep` survive.
 *
 * Returns the would-be archived names. `skipped` is reserved for repos
 * that fail the unmount in the real run; the dry-run path leaves it
 * empty since we never attempt the operation.
 */
async function pickReposToArchive(
  client: RotateActionEsClient,
  settings: SettingsDoc,
  keep: number
): Promise<{ archived: string[]; skipped: string[] }> {
  const allRepos = await getAllRepos(client);
  const eligible = allRepos
    .filter(
      (r) =>
        r.name.startsWith(`${settings.repo_name_prefix}-`) &&
        r.is_mounted &&
        r.thaw_state === 'active'
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  if (eligible.length <= keep) {
    return { archived: [], skipped: [] };
  }

  const toArchive = eligible.slice(0, eligible.length - keep).map((r) => r.name);
  return { archived: toArchive, skipped: [] };
}

/**
 * Run a real rotation. Throws `MissingIndexError`/`MissingSettingsError`
 * if the cluster is uninitialized; `ActionError` for bucket rotation.
 * Non-critical step failures (ILM retarget, individual archive
 * unmounts) degrade to warnings in `errors[]` and do not abort the run.
 */
export async function runRotate(
  client: RotateActionEsClient,
  config: RotateConfig = {},
  options: RunRotateOptions = {}
): Promise<RotateResult> {
  const log = options.log ?? NOOP_LOG;
  const started_at = new Date().toISOString();

  const settings = await loadInitializedSettings(client);
  const resolved = resolveRotation(settings, config);

  const steps: RotateStepRecord[] = [];
  const errors: ServiceError[] = [];

  await createSnapshotRepository(client, {
    name: resolved.new_repo_name,
    provider: settings.provider,
    bucket: resolved.new_bucket,
    base_path: resolved.new_base_path,
    canned_acl: settings.canned_acl,
    storage_class: settings.storage_class,
  });
  steps.push({
    type: 'snapshot_repository',
    action: 'created',
    name: resolved.new_repo_name,
    detail: `${resolved.new_bucket}/${resolved.new_base_path}`,
  });

  const newRepoDoc: RepositoryDoc = {
    doctype: 'repository',
    name: resolved.new_repo_name,
    bucket: resolved.new_bucket,
    base_path: resolved.new_base_path,
    start: null,
    end: null,
    is_thawed: false,
    is_mounted: true,
    thaw_state: 'active',
    thawed_at: null,
    expires_at: null,
  };
  await saveRepositoryDoc(client, newRepoDoc);
  steps.push({ type: 'repository_doc', action: 'created', name: resolved.new_repo_name });

  const updatedSettings: SettingsDoc = { ...settings, last_suffix: resolved.next_suffix };
  await saveSettings(client, updatedSettings);
  steps.push({
    type: 'settings',
    action: 'updated',
    detail: `last_suffix → ${resolved.next_suffix}`,
  });

  if (settings.ilm_policy_name) {
    await rotateVersionedIlmPolicy({
      client,
      basePolicyName: settings.ilm_policy_name,
      oldSuffix: settings.last_suffix, // pre-rotation suffix (or null if first rotation)
      newSuffix: resolved.next_suffix,
      newRepoName: resolved.new_repo_name,
      steps,
      errors,
      log,
    });
  }

  const keep = config.keep ?? 1;
  const { archived: candidates } = await pickReposToArchive(client, settings, keep);
  const archived: string[] = [];
  const skipped: string[] = [];

  for (const name of candidates) {
    try {
      await deleteSnapshotRepository(client, name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Failed to unmount ${name}: ${msg}`);
      errors.push({
        code: 'ACTION_FAILED',
        message: `Failed to unmount ${name}: ${msg}`,
        severity: 'warning',
        target: name,
      });
      skipped.push(name);
      steps.push({ type: 'snapshot_repository', action: 'skipped', name });
      continue;
    }

    // Successful unmount — flip the doc to frozen.
    const existing = (await getAllRepos(client)).find((r) => r.name === name);
    if (existing) {
      await saveRepositoryDoc(client, {
        ...existing,
        is_mounted: false,
        thaw_state: 'frozen',
      });
    }
    archived.push(name);
    steps.push({ type: 'snapshot_repository', action: 'archived', name });
  }

  return {
    success: true,
    dry_run: false,
    new_repo_name: resolved.new_repo_name,
    new_bucket: resolved.new_bucket,
    new_base_path: resolved.new_base_path,
    archived,
    skipped,
    steps,
    errors,
    started_at,
    completed_at: new Date().toISOString(),
  };
}
