/**
 * Domain exceptions for the deepfreeze plugin.
 *
 * Mirrors `packages/deepfreeze-core/deepfreeze_core/exceptions.py`.
 *
 * At the HTTP route boundary these are mapped to `ServiceError` (see
 * `common/types/errors.ts`); inside the server they propagate as
 * regular Error subclasses.
 */

export class DeepfreezeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeepfreezeError';
  }
}

/** The `deepfreeze-status` index does not exist. */
export class MissingIndexError extends DeepfreezeError {
  constructor(message: string) {
    super(message);
    this.name = 'MissingIndexError';
  }
}

/** The status index exists, but the settings document is missing. */
export class MissingSettingsError extends DeepfreezeError {
  constructor(message: string) {
    super(message);
    this.name = 'MissingSettingsError';
  }
}

/** Generic action-level failure (Elasticsearch unreachable, query failed, etc.). */
export class ActionError extends DeepfreezeError {
  constructor(message: string) {
    super(message);
    this.name = 'ActionError';
  }
}

/**
 * One or more setup preconditions weren't satisfied. The `issues`
 * array holds plain-text descriptions intended for direct display in
 * the wizard UI.
 *
 * Mirrors `PreconditionError` in
 *   packages/deepfreeze-core/deepfreeze_core/exceptions.py
 */
export class PreconditionError extends DeepfreezeError {
  public readonly issues: string[];

  constructor(message: string, issues: string[]) {
    super(message);
    this.name = 'PreconditionError';
    this.issues = issues;
  }
}
