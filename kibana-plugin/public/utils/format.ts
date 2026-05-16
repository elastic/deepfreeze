/**
 * Trim a date/datetime string to YYYY-MM-DDTHH:MM (16 chars).
 * Strips milliseconds, seconds, and timezone suffixes for compact display.
 */
export function trimDate(val: unknown): string {
  if (!val) return '';
  let s = String(val);
  s = s.replace(/Z$/, '').replace(/[+-]\d{2}:\d{2}$/, '');
  if (s.length > 16) {
    s = s.substring(0, 16);
  }
  return s;
}

/** Format a duration in ms as "Xms" or "Y.Ys". */
export function formatDuration(ms: number): string {
  if (ms === undefined || ms === null) return '--';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
