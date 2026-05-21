/**
 * Rotate action — create the next-suffix snapshot repository, create a
 * versioned ILM policy pointing at it, retarget index templates onto
 * that new versioned policy, capture each mounted repo's data date
 * range, and unmount older repositories that fall outside the `keep`
 * window.
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
import {
  updateRepositoryDateRange,
  type DateRangeEsClient,
} from '../repositories/repository_date_range';
import type { StorageClient } from '../storage/types';

/** Full ES surface required by `runRotate`. */
export type RotateActionEsClient = SettingsRepoWriteEsClient &
  RepositoryRepoWriteEsClient &
  SnapshotRepoEsClient &
  IlmRepoWriteEsClient &
  IndexTemplateEsClient &
  DateRangeEsClient;

/**
 * Default value for `keep` when the route caller doesn't supply one.
 * The UI seeds its own input with this; the server falls back to it
 * for direct API calls that omit `keep`. Chosen as 6 so a typical
 * monthly-rotation site retains six months of hot data by default.
 */
export const DEFAULT_KEEP = 6;

/**
 * Default S3 storage class for objects in repos that fall out of the
 * `keep` window. Matches `push_to_glacier`'s default in the Python port
 * (`packages/deepfreeze-core/deepfreeze_core/utilities.py`).
 */
export const DEFAULT_ARCHIVE_STORAGE_CLASS = 'GLACIER';

export interface RotateConfig {
  /** Number of newest active repositories to keep mounted. Defaults to 6. */
  keep?: number;
  /** Required when `settings.style === 'date'`; otherwise ignored. */
  year?: number;
  /** Required when `settings.style === 'date'`; otherwise ignored. */
  month?: number;
}

export interface RunRotateOptions {
  log?: { debug: (m: string) => void; warn: (m: string) => void };
  /**
   * Optional storage client used to transition each archived repo's
   * objects to a cheap-archive tier before the repo is unmounted from
   * ES. Mirrors `push_to_glacier` in the Python port.
   *
   * When omitted (or when sampling a repo fails), the unmount still
   * happens — the doc still flips to `frozen` — but objects stay in
   * their original storage class. Operators relying on bucket-level
   * S3 lifecycle policies can leave this unset.
   */
  storage?: StorageClient;
  /**
   * Target storage class for the refreeze step. Defaults to `GLACIER`.
   * Pass `DEEP_ARCHIVE` for sites that want maximum cold storage at the
   * cost of slower restores.
   */
  archive_storage_class?: string;
}

const NOOP_LOG = { debug: () => {}, warn: () => {} };

export interface RotateStepRecord {
  type:
    | 'snapshot_repository'
    | 'settings'
    | 'repository_doc'
    | 'ilm_policy'
    | 'index_template'
    | 'date_range'
    | 'archive_objects';
  action:
    | 'would_create'
    | 'would_update'
    | 'would_archive'
    | 'would_archive_objects'
    | 'created'
    | 'updated'
    | 'unchanged'
    | 'archived'
    | 'archived_objects'
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

  const keep = config.keep ?? DEFAULT_KEEP;
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
  // Enumerate mounted repos so the preview shows what date-range
  // updates the real run would attempt. We don't actually query
  // @timestamp here (that's the real run's job).
  const mountedForPreview = (await getAllRepos(client)).filter(
    (r) => r.name.startsWith(`${settings.repo_name_prefix}-`) && r.is_mounted
  );
  for (const r of mountedForPreview) {
    steps.push({
      type: 'date_range',
      action: 'would_update',
      name: r.name,
      detail:
        r.start && r.end
          ? `extend if @timestamp range outside ${r.start} → ${r.end}`
          : 'capture @timestamp range from snapshot indices',
    });
  }
  for (const r of archived) {
    steps.push({ type: 'snapshot_repository', action: 'would_archive', name: r });
    steps.push({
      type: 'archive_objects',
      action: 'would_archive_objects',
      name: r,
      detail: `transition objects under bucket/base_path → ${DEFAULT_ARCHIVE_STORAGE_CLASS}`,
    });
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
  const storage = options.storage;
  const archiveStorageClass =
    options.archive_storage_class ?? DEFAULT_ARCHIVE_STORAGE_CLASS;
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

  // Capture date ranges for every currently-mounted repo BEFORE the
  // archive step removes their searchable-snapshot indices. Mirrors
  // `Rotate._update_date_ranges` in
  //   packages/deepfreeze-core/deepfreeze_core/actions/rotate.py
  // which runs at the same point in the rotation flow.
  //
  // The update is unconditional per Python's logic (no missing-date
  // skip) — `updateRepositoryDateRange` is idempotent via its
  // only-extend merge, so repeated calls are safe and only persist
  // when something actually changes.
  {
    const allRepos = await getAllRepos(client);
    const mounted = allRepos.filter(
      (r) =>
        r.name.startsWith(`${settings.repo_name_prefix}-`) && r.is_mounted
    );
    for (const repo of mounted) {
      try {
        const outcome = await updateRepositoryDateRange(client, repo);
        if (outcome.changed) {
          steps.push({
            type: 'date_range',
            action: 'updated',
            name: repo.name,
            detail: `${outcome.start} → ${outcome.end}`,
          });
        } else if (outcome.error) {
          log.warn(`Date-range update failed for ${repo.name}: ${outcome.error}`);
          errors.push({
            code: 'ACTION_FAILED',
            message: `Date-range update failed for ${repo.name}: ${outcome.error}`,
            severity: 'warning',
            target: repo.name,
          });
        } else if (
          outcome.skipped_reason &&
          outcome.skipped_reason !== 'no change after only-extend merge'
        ) {
          // Surface informative skip reasons (no snapshots, no mounted
          // indices, no @timestamp values) so operators can tell why
          // dates haven't populated. The only-extend no-op is silent
          // because it's the steady state once dates are populated.
          steps.push({
            type: 'date_range',
            action: 'skipped',
            name: repo.name,
            detail: outcome.skipped_reason,
          });
        }
      } catch (err) {
        // updateRepositoryDateRange traps its own errors into outcome.error,
        // but defensive in case the contract changes.
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`Date-range update threw for ${repo.name}: ${msg}`);
      }
    }
  }

  const keep = config.keep ?? DEFAULT_KEEP;
  const { archived: candidates } = await pickReposToArchive(client, settings, keep);
  const archived: string[] = [];
  const skipped: string[] = [];

  for (const name of candidates) {
    // Per-repo backstop: one final date-range capture right before
    // unmount, in case anything changed between the bulk pass above and
    // now. Mirrors Python's `unmount_repo` (utilities.py) which makes
    // the same defensive call before delete_repository.
    const repoToArchive = (await getAllRepos(client)).find((r) => r.name === name);
    if (repoToArchive) {
      try {
        await updateRepositoryDateRange(client, repoToArchive);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`Pre-unmount date-range capture failed for ${name}: ${msg}`);
      }
    }

    // Push the repo's objects to the archive storage class BEFORE
    // unmounting. Mirrors `Rotate.do_action`'s call order in
    // `packages/deepfreeze-core/deepfreeze_core/actions/rotate.py` —
    // refreeze first, then unmount. A failed refreeze does NOT abort
    // the unmount: the repo still leaves the keep window, and partial
    // archival is logged for follow-up. If the operator runs rotate
    // without a storage client wired (no AWS creds resolved at route
    // setup time), the refreeze step is silently skipped and bucket-
    // level S3 lifecycle policies are assumed to handle the archival.
    if (storage && repoToArchive && repoToArchive.bucket) {
      // Match Python's normalization: strip leading/trailing slashes,
      // re-append exactly one trailing slash so the prefix matches
      // every object under the repo's base_path and only that.
      const trimmed = repoToArchive.base_path.replace(/^\/+|\/+$/g, '');
      const prefix = trimmed ? `${trimmed}/` : '';
      try {
        const summary = await storage.refreeze(
          repoToArchive.bucket,
          prefix,
          archiveStorageClass
        );
        const detail =
          `${summary.refrozen} refrozen, ${summary.skipped} already ${archiveStorageClass}` +
          (summary.errors > 0 ? `, ${summary.errors} errors` : '');
        steps.push({
          type: 'archive_objects',
          action: 'archived_objects',
          name,
          detail,
        });
        if (summary.errors > 0) {
          log.warn(
            `Refreeze for ${name} completed with ${summary.errors} per-object errors`
          );
          errors.push({
            code: 'ACTION_FAILED',
            message: `Refreeze for ${name} had ${summary.errors} per-object errors`,
            severity: 'warning',
            target: name,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`Refreeze for ${name} failed; proceeding with unmount: ${msg}`);
        errors.push({
          code: 'ACTION_FAILED',
          message: `Refreeze for ${name} failed: ${msg}`,
          severity: 'warning',
          target: name,
        });
        steps.push({
          type: 'archive_objects',
          action: 'skipped',
          name,
          detail: msg,
        });
      }
    } else if (!storage) {
      log.debug(
        `No storage client; skipping refreeze for ${name} — bucket-level S3 lifecycle policies must handle archival`
      );
    }

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
