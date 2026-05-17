/**
 * Rotate action — create the next-suffix snapshot repository, retarget
 * the configured ILM policy, and unmount older repositories that fall
 * outside the `keep` window.
 *
 * Mirrors `Rotate.do_action` in
 *   packages/deepfreeze-core/deepfreeze_core/actions/rotate.py
 * with three deliberate simplifications for the Kibana port:
 *
 *   1. **rotate_by='bucket' is unsupported.** Bucket-rotation needs the
 *      storage SDK (deferred to Phase 4). If `settings.rotate_by` is
 *      `'bucket'` we throw `NotSupportedError`. The wizard locks
 *      rotate_by to `'path'` so this only fires for clusters set up
 *      via the Python CLI.
 *   2. **No `push_to_glacier`.** That requires the storage SDK too.
 *      Bucket lifecycle policies (set externally) handle archival.
 *   3. **No versioned ILM policies.** The base ILM policy is retargeted
 *      to the new repo via the same `createOrUpdateIlmPolicy` helper
 *      Setup uses. The Python CLI's per-rotation policy versioning
 *      (`policy-000001`, `policy-000002`, …) is dropped — existing
 *      mounted indices continue to use whatever repo they bound to at
 *      mount time, and new frozen-phase transitions use the new repo.
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
  createOrUpdateIlmPolicy,
  type IlmRepoWriteEsClient,
} from '../repositories/ilm_repo';

/** Full ES surface required by `runRotate`. */
export type RotateActionEsClient = SettingsRepoWriteEsClient &
  RepositoryRepoWriteEsClient &
  SnapshotRepoEsClient &
  IlmRepoWriteEsClient;

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
  type: 'snapshot_repository' | 'settings' | 'repository_doc' | 'ilm_policy';
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
    steps.push({
      type: 'ilm_policy',
      action: 'would_update',
      name: settings.ilm_policy_name,
      detail: `→ ${resolved.new_repo_name}`,
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
    try {
      const ilmResult = await createOrUpdateIlmPolicy(
        client,
        settings.ilm_policy_name,
        resolved.new_repo_name
      );
      steps.push({
        type: 'ilm_policy',
        action: ilmResult.action,
        name: settings.ilm_policy_name,
        detail: `→ ${resolved.new_repo_name}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Failed to retarget ILM policy ${settings.ilm_policy_name}: ${msg}`);
      errors.push({
        code: 'ACTION_FAILED',
        message: `Failed to retarget ILM policy ${settings.ilm_policy_name}: ${msg}`,
        severity: 'warning',
        target: settings.ilm_policy_name,
      });
    }
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
