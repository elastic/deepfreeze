import { ActionTracker } from '../tracker';

describe('ActionTracker', () => {
  it('starts in a successful state with no results or errors', () => {
    const tracker = new ActionTracker('rotate', false, { keep: 6 });

    expect(tracker.action).toBe('rotate');
    expect(tracker.dryRun).toBe(false);
    expect(tracker.parameters).toEqual({ keep: 6 });
    expect(tracker.results).toEqual([]);
    expect(tracker.errors).toEqual([]);
    expect(tracker.summary).toBeNull();
    expect(tracker.success).toBe(true);
  });

  it('addResult appends to the results list without changing success', () => {
    const tracker = new ActionTracker('rotate', false, {});

    tracker.addResult({ type: 'repository', action: 'created', target: 'deepfreeze-000001' });
    tracker.addResult({ type: 'ilm_policy', action: 'updated' });

    expect(tracker.results).toHaveLength(2);
    expect(tracker.results[0].target).toBe('deepfreeze-000001');
    expect(tracker.success).toBe(true);
  });

  it('addError flips success to false', () => {
    const tracker = new ActionTracker('thaw', false, {});

    expect(tracker.success).toBe(true);
    tracker.addError({ code: 'GLACIER_RESTORE_FAILED', message: 'tier=Expedited rate-limited' });

    expect(tracker.errors).toHaveLength(1);
    expect(tracker.success).toBe(false);
  });

  it('markSuccess after addError restores the success flag (matches Python semantics)', () => {
    const tracker = new ActionTracker('cleanup', false, {});
    tracker.addError({ code: 'WARN', message: 'partial' });

    expect(tracker.success).toBe(false);
    tracker.markSuccess();
    expect(tracker.success).toBe(true);
  });

  it('setSummary replaces the summary in place', () => {
    const tracker = new ActionTracker('rotate', false, {});
    tracker.setSummary({ new_repo: 'deepfreeze-000001' });

    expect(tracker.summary).toEqual({ new_repo: 'deepfreeze-000001' });

    tracker.setSummary({ new_repo: 'deepfreeze-000002', replaced: true });
    expect(tracker.summary).toEqual({ new_repo: 'deepfreeze-000002', replaced: true });
  });

  it('durationMs is non-negative and monotonic', async () => {
    const tracker = new ActionTracker('rotate', false, {});

    const d1 = tracker.durationMs;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const d2 = tracker.durationMs;

    expect(d1).toBeGreaterThanOrEqual(0);
    expect(d2).toBeGreaterThanOrEqual(d1);
  });
});
