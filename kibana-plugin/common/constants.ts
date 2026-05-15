/**
 * Constants shared between the Kibana plugin server and public code.
 *
 * Values here must stay in lockstep with the Python implementation at
 * packages/deepfreeze-core/deepfreeze_core/constants.py — they are the
 * compatibility contract between the two implementations writing to the
 * same Elasticsearch indices.
 */

export const STATUS_INDEX = 'deepfreeze-status';
export const AUDIT_INDEX = 'deepfreeze-audit';
export const SETTINGS_ID = '1';

export const PROVIDERS = ['aws', 'azure', 'gcp'] as const;
export type Provider = (typeof PROVIDERS)[number];

/** Repository thaw lifecycle states. */
export const THAW_STATES = ['active', 'frozen', 'thawing', 'thawed', 'expired'] as const;
export type ThawState = (typeof THAW_STATES)[number];

/** Thaw request status lifecycle. */
export const THAW_REQUEST_STATUSES = [
  'in_progress',
  'completed',
  'failed',
  'refrozen',
] as const;
export type ThawRequestStatus = (typeof THAW_REQUEST_STATUSES)[number];

/** Doctype discriminator values used in the status index. */
export const DOCTYPE = {
  repository: 'repository',
  thaw_request: 'thaw_request',
  settings: 'settings',
  scheduled_job: 'scheduled_job',
} as const;
export type Doctype = (typeof DOCTYPE)[keyof typeof DOCTYPE];

/** Prefix applied to scheduled-job document IDs in the status index. */
export const SCHEDULED_JOB_ID_PREFIX = 'scheduled_job:';
