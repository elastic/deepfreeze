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
} as const;
