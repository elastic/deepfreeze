/**
 * Display formatters for dates and durations shown in the UI.
 *
 * Three date helpers, three intents:
 *
 *   - `formatTimestamp(val)` — full wall-clock datetime in the
 *     browser's local timezone, e.g. "2026-05-19 13:45 EDT". Use for
 *     real event timestamps the operator cares about as "when did
 *     this happen on my clock": created_at, expires_at, thawed_at,
 *     last_run_at, audit `timestamp`, thaw `checked_at`.
 *
 *   - `formatStoredDatetime(val)` — the stored ISO datetime, minus
 *     just the millisecond fraction. Keeps the Z so UTC is explicit.
 *     Use for fields where the value IS the data — e.g. repository
 *     `start`/`end` are the min/max `@timestamp` of the indexed
 *     documents themselves; the operator wants to see "exactly what's
 *     in the repo" without browser-TZ rewriting that property.
 *
 *   - `formatDate(val)` — date portion of the ISO string with NO
 *     timezone conversion, e.g. "2026-05-19". Use for date-range
 *     boundaries where the stored Y-M-D is the meaningful unit and
 *     there's no time component to preserve. Currently no callers
 *     after thaw request dates picked up sub-day precision (they now
 *     use `formatStoredDatetime` so the user's chosen time shows
 *     through). Kept for future Y-M-D-only contexts (e.g. a Setup
 *     wizard date selector). We don't TZ-convert because the user's
 *     Jan 15 should stay Jan 15 regardless of where their browser sits.
 *
 * All three are forgiving: null/undefined/empty → "", an unparseable
 * string falls through to the raw input so we never silently swallow
 * a malformed timestamp.
 */

/**
 * Single Intl.DateTimeFormat instance (constructor allocation is the
 * expensive part of Intl, format() is cheap). `undefined` locale means
 * "use the browser's default."
 *
 * Options chosen for compact tables: 2-digit Y-M-D + 24h time + short
 * timezone name. Locale dictates the separator (en-US: `05/19/2026,
 * 13:45 EDT`; ja-JP: `2026/05/19 13:45 JST`).
 */
const TS_FORMAT = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZoneName: 'short',
});

/** Local-TZ datetime with TZ marker for any real-instant field. */
export function formatTimestamp(val: unknown): string {
  if (val === null || val === undefined || val === '') return '';
  const d = new Date(String(val));
  if (Number.isNaN(d.getTime())) return String(val);
  return TS_FORMAT.format(d);
}

/**
 * Stored datetime, milliseconds stripped, Z preserved. The shape used
 * for "this is the actual `@timestamp` range of the indexed data" so
 * the operator sees exactly what's in the repo without browser-TZ
 * rewriting it. `2026-05-19T13:45:00.000Z` → `2026-05-19T13:45:00Z`.
 */
export function formatStoredDatetime(val: unknown): string {
  if (val === null || val === undefined || val === '') return '';
  return String(val).replace(/\.\d+(?=Z$|[+-]\d{2}:\d{2}$)/, '');
}

/**
 * Date-only display for range boundaries. Extracts the literal Y-M-D
 * substring from the ISO string so a user-picked "2026-01-15" stays
 * "2026-01-15" regardless of the browser's timezone.
 */
export function formatDate(val: unknown): string {
  if (val === null || val === undefined || val === '') return '';
  const m = String(val).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : String(val);
}

/** Format a duration in ms as "Xms" or "Y.Ys". */
export function formatDuration(ms: number): string {
  if (ms === undefined || ms === null) return '--';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
