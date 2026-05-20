import { formatDate, formatDuration, formatTimestamp } from '../format';

describe('formatTimestamp', () => {
  it('returns empty for null / undefined / empty string', () => {
    expect(formatTimestamp(null)).toBe('');
    expect(formatTimestamp(undefined)).toBe('');
    expect(formatTimestamp('')).toBe('');
  });

  it('renders an ISO timestamp in the host TZ (test runs in UTC by default)', () => {
    // Jest defaults to whatever TZ the host runs in; we lock to UTC for
    // reproducibility via TZ=UTC at the npm-script level. The output
    // shape we care about: contains the date, a 24h time, and a TZ
    // abbreviation. Locale-specific punctuation may vary across Node
    // versions, so we assert structurally rather than on a literal.
    const out = formatTimestamp('2026-05-19T13:45:00Z');
    expect(out).toMatch(/2026/);
    expect(out).toMatch(/05/);
    expect(out).toMatch(/19/);
    // 24h time with the colon between hours and minutes.
    expect(out).toMatch(/\d{2}:\d{2}/);
    // Some short TZ marker (UTC / GMT / EDT / EST / etc).
    expect(out).toMatch(/\b[A-Z]{2,5}\b/);
  });

  it('falls through unparseable strings instead of returning "Invalid Date"', () => {
    expect(formatTimestamp('not a date')).toBe('not a date');
  });
});

describe('formatDate', () => {
  it('returns empty for null / undefined / empty string', () => {
    expect(formatDate(null)).toBe('');
    expect(formatDate(undefined)).toBe('');
    expect(formatDate('')).toBe('');
  });

  it('extracts the literal Y-M-D from a full ISO timestamp', () => {
    expect(formatDate('2026-01-15T00:00:00.000Z')).toBe('2026-01-15');
    expect(formatDate('2026-01-15T23:59:59.999Z')).toBe('2026-01-15');
  });

  it('preserves Y-M-D regardless of TZ (no back-shift on UTC-midnight inputs)', () => {
    // The whole point of this helper: a user in EST who picked Jan 15
    // sees Jan 15, not Jan 14 (which is what TZ conversion would give
    // for a UTC-midnight input).
    expect(formatDate('2026-01-15T00:00:00.000Z')).toBe('2026-01-15');
  });

  it('accepts a plain Y-M-D string', () => {
    expect(formatDate('2026-01-15')).toBe('2026-01-15');
  });

  it('falls through anything we cannot parse a leading Y-M-D from', () => {
    expect(formatDate('garbage')).toBe('garbage');
  });
});

describe('formatDuration', () => {
  it('renders sub-second durations as ms', () => {
    expect(formatDuration(150)).toBe('150ms');
  });
  it('renders >= 1s durations as Y.Ys', () => {
    expect(formatDuration(1500)).toBe('1.5s');
  });
  it('handles null / undefined defensively', () => {
    expect(formatDuration(null as unknown as number)).toBe('--');
    expect(formatDuration(undefined as unknown as number)).toBe('--');
  });
});
