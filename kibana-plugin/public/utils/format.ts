/**
 * Display formatters for dates and durations shown in the UI.
 *
 * Two date helpers, two intents:
 *
 *   - `formatTimestamp(val)` — full wall-clock datetime in the
 *     browser's local timezone, e.g. "2026-05-19 13:45 EDT". Use for
 *     real event timestamps: created_at, expires_at, thawed_at,
 *     last_run_at, audit `timestamp`, thaw `checked_at`.
 *
 *   - `formatDate(val)` — date portion of the ISO string with NO
 *     timezone conversion, e.g. "2026-05-19". Use for date-range
 *     boundaries where the stored Y-M-D is the meaningful unit:
 *     repository `start`/`end` (from @timestamp aggregation, treated
 *     as date span) and thaw request `start_date`/`end_date` (user-
 *     picked dates, stored as UTC midnight / EOD — converting to the
 *     browser TZ would back-shift them by a day for users east/west
 *     of UTC, which is surprising).
 *
 * Both are forgiving: null/undefined/empty → "", an unparseable
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
