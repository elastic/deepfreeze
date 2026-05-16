/**
 * Settings document access for the `deepfreeze-status` index.
 *
 * Mirrors `get_settings` in
 *   packages/deepfreeze-core/deepfreeze_core/utilities.py
 */

import { SETTINGS_ID, STATUS_INDEX } from '../../common/constants';
import {
  SETTINGS_DEFAULTS,
  type SettingsDoc,
} from '../../common/schemas/settings';
import { MissingIndexError } from '../errors';

/**
 * Minimal structural ES client interface for the settings repository.
 *
 * `get` follows the `@elastic/elasticsearch` v9 shape: returns an object
 * with `_source` and `found`. A 404 from ES surfaces as a thrown error
 * whose body has `{ found: false }` — we detect it via `statusCode` /
 * `meta.statusCode` since both shapes appear across client versions.
 */
export interface SettingsRepoEsClient {
  indices: {
    exists: (params: { index: string }) => Promise<boolean> | boolean;
  };
  get: (params: {
    index: string;
    id: string;
  }) => Promise<{ _source?: Record<string, unknown>; found?: boolean }>;
}

/**
 * Fetch the singleton settings document.
 *
 * Returns `null` when the document is missing inside an existing index.
 * Throws `MissingIndexError` when the index itself is absent.
 */
export async function getSettings(
  client: SettingsRepoEsClient
): Promise<SettingsDoc | null> {
  const exists = await client.indices.exists({ index: STATUS_INDEX });
  if (!exists) {
    throw new MissingIndexError(`Status index ${STATUS_INDEX} is missing`);
  }

  let result: { _source?: Record<string, unknown>; found?: boolean };
  try {
    result = await client.get({ index: STATUS_INDEX, id: SETTINGS_ID });
  } catch (err) {
    if (isNotFound(err)) {
      return null;
    }
    throw err;
  }

  if (result.found === false || !result._source) {
    return null;
  }

  return normalizeSettings(result._source);
}

/**
 * Drop the `doctype` discriminator, fill in defaults for any fields the
 * stored document is missing.
 *
 * The Python `Settings` constructor merges a settings_hash on top of
 * defaults; this is the TS-side equivalent so callers always receive a
 * fully-typed object even when older documents omit recent fields.
 */
function normalizeSettings(source: Record<string, unknown>): SettingsDoc {
  const { doctype: _doctype, ...rest } = source;
  return {
    ...SETTINGS_DEFAULTS,
    ...(rest as Partial<SettingsDoc>),
    doctype: 'settings',
  };
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const e = err as { statusCode?: number; meta?: { statusCode?: number } };
  return e.statusCode === 404 || e.meta?.statusCode === 404;
}
