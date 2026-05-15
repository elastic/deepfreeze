import type { ActionResult, AuditActionError } from './types';

/**
 * Accumulates results, errors, and timing data during the execution of
 * a deepfreeze action so that the AuditLogger can write a single audit
 * document when the action completes.
 *
 * Mirrors `ActionTracker` in
 *   packages/deepfreeze-core/deepfreeze_core/audit.py
 *
 * Use via `AuditLogger.track(action, dryRun, params, async (tracker) => …)`
 * for automatic commit-on-exit, or via `AuditLogger.startTracking()` +
 * `AuditLogger.commit(tracker)` for manual flows.
 */
export class ActionTracker {
  public readonly action: string;
  public readonly dryRun: boolean;
  public readonly parameters: Record<string, unknown>;
  public readonly results: ActionResult[] = [];
  public readonly errors: AuditActionError[] = [];
  public summary: Record<string, unknown> | null = null;

  private _success = true;
  private readonly _startedAtMs: number;

  constructor(action: string, dryRun: boolean, parameters: Record<string, unknown>) {
    this.action = action;
    this.dryRun = dryRun;
    this.parameters = parameters;
    this._startedAtMs = Date.now();
  }

  addResult(result: ActionResult): void {
    this.results.push(result);
  }

  /** Adding an error implicitly marks the action as failed. */
  addError(error: AuditActionError): void {
    this.errors.push(error);
    this._success = false;
  }

  setSummary(summary: Record<string, unknown>): void {
    this.summary = summary;
  }

  markSuccess(): void {
    this._success = true;
  }

  markFailed(): void {
    this._success = false;
  }

  get success(): boolean {
    return this._success;
  }

  get durationMs(): number {
    return Date.now() - this._startedAtMs;
  }
}
