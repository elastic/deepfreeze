import type { Provider } from '../constants';

/**
 * Settings document stored in the `deepfreeze-status` index at id `SETTINGS_ID`.
 *
 * Wire format (snake_case). Source-of-truth in Python:
 *   packages/deepfreeze-core/deepfreeze_core/helpers.py — Settings.to_dict()
 *
 * `last_suffix` tracks the most recently allocated numeric/date suffix for
 * `oneup` style rotation. `null` until the first rotation.
 */
export interface SettingsDoc {
  doctype: 'settings';
  repo_name_prefix: string;
  bucket_name_prefix: string;
  base_path_prefix: string;
  canned_acl: string;
  storage_class: string;
  provider: Provider;
  rotate_by: 'path' | 'bucket';
  style: 'oneup' | 'date';
  last_suffix: string | null;
  ilm_policy_name: string | null;
  index_template_name: string | null;
  thaw_request_retention_days_completed: number;
  thaw_request_retention_days_failed: number;
  thaw_request_retention_days_refrozen: number;
}

/** Defaults must match Settings.__init__ in helpers.py. */
export const SETTINGS_DEFAULTS: SettingsDoc = {
  doctype: 'settings',
  repo_name_prefix: 'deepfreeze',
  bucket_name_prefix: 'deepfreeze',
  base_path_prefix: 'snapshots',
  canned_acl: 'private',
  storage_class: 'standard',
  provider: 'aws',
  rotate_by: 'path',
  style: 'oneup',
  last_suffix: null,
  ilm_policy_name: null,
  index_template_name: null,
  thaw_request_retention_days_completed: 7,
  thaw_request_retention_days_failed: 30,
  thaw_request_retention_days_refrozen: 35,
};
