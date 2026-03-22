/**
 * Trim a date/datetime string to YYYY-MM-DDTHH:MM format.
 * Removes seconds, milliseconds, and timezone suffixes.
 */
export function trimDate(val: unknown): string {
  if (!val) return '';
  let s = String(val);
  // Remove timezone suffix
  s = s.replace(/Z$/, '').replace(/[+-]\d{2}:\d{2}$/, '');
  // Trim to YYYY-MM-DDTHH:MM (16 chars)
  if (s.length > 16) {
    s = s.substring(0, 16);
  }
  return s;
}
