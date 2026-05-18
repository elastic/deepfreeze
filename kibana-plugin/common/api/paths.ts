/**
 * HTTP path constants shared between server and public.
 *
 * `BASE_PATH` is the namespace for every plugin-owned route. Keep all
 * route paths defined here so both halves stay in lockstep.
 */

export const BASE_PATH = '/api/deepfreeze';

export const API = {
  status: `${BASE_PATH}/status`,
  audit: `${BASE_PATH}/audit`,
  setupOptions: `${BASE_PATH}/setup/options`,
  setupDryRun: `${BASE_PATH}/setup/dry-run`,
  setup: `${BASE_PATH}/setup`,
  rotate: `${BASE_PATH}/rotate`,
  cleanup: `${BASE_PATH}/cleanup`,
  refreeze: `${BASE_PATH}/refreeze`,
  thaw: `${BASE_PATH}/thaw`,
  /**
   * `${id}` placeholder; routes register the literal `/{id}` path and
   * callers `paths.thawProgress(id)` for typed URL construction.
   */
  thawProgress: (id: string) => `${BASE_PATH}/thaw-requests/${id}/progress`,
  thawCheck: (id: string) => `${BASE_PATH}/thaw-requests/${id}/check`,
  thawProgressPattern: `${BASE_PATH}/thaw-requests/{id}/progress`,
  thawCheckPattern: `${BASE_PATH}/thaw-requests/{id}/check`,
} as const;
