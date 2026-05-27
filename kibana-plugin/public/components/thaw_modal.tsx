import React, { useCallback, useState } from 'react';
import {
  EuiBadge,
  EuiButton,
  EuiButtonEmpty,
  EuiCallOut,
  EuiDatePicker,
  EuiFieldNumber,
  EuiForm,
  EuiFormRow,
  EuiModal,
  EuiModalBody,
  EuiModalFooter,
  EuiModalHeader,
  EuiModalHeaderTitle,
  EuiSelect,
  EuiSpacer,
  EuiText,
} from '@elastic/eui';
import type { CoreStart } from '@kbn/core/public';
import moment, { type Moment } from 'moment';

import { API } from '../../common/api/paths';
import { StepList } from './step_list';
import type { ThawResult } from '../../server/actions/thaw';

/**
 * Mirrors the server-side defaults / bounds in
 * `server/actions/thaw.ts`. Kept local instead of imported so the
 * browser bundle doesn't pull in the server module.
 */
const DEFAULT_RESTORE_DAYS = 7;
const MIN_RESTORE_DAYS = 1;
const MAX_RESTORE_DAYS = 30;
type RetrievalTier = 'Standard' | 'Expedited' | 'Bulk';
const DEFAULT_RETRIEVAL_TIER: RetrievalTier = 'Standard';

const TIER_OPTIONS: Array<{ value: RetrievalTier; text: string }> = [
  { value: 'Standard', text: 'Standard (3–5 hr, $)' },
  { value: 'Expedited', text: 'Expedited (1–5 min, $$$)' },
  { value: 'Bulk', text: 'Bulk (5–12 hr, $)' },
];

interface ThawModalProps {
  http: CoreStart['http'];
  notifications: CoreStart['notifications'];
  onClose: () => void;
  onComplete: () => void;
}

interface ApiError {
  body?: { message?: string; attributes?: { code?: string } };
  message?: string;
}

function extractErrorMessage(err: unknown): string {
  const e = err as ApiError;
  return e?.body?.message ?? e?.message ?? 'Unknown error';
}

/**
 * Convert a moment (constrained to UTC, see `utcOffset={0}` below) to
 * the canonical ISO 8601 string the server expects. The moment is
 * already in UTC so `.toISOString()` produces the right wire value.
 *
 * Returns the empty string when the moment is null / invalid so the
 * existing range-validity checks (`startMoment != null && ...`) still
 * work without nullable plumbing.
 */
function toIso(m: Moment | null): string {
  return m && m.isValid() ? m.toISOString() : '';
}

/**
 * "Initiate thaw" modal: collects a date range and POSTs to the
 * thaw route. A preview step is required before the irreversible run
 * (the server actually saves the thaw_request doc and fires S3
 * restores once the user confirms).
 */
export function ThawModal({
  http,
  notifications,
  onClose,
  onComplete,
}: ThawModalProps) {
  const [startDate, setStartDate] = useState<Moment | null>(null);
  const [endDate, setEndDate] = useState<Moment | null>(null);
  const [restoreDays, setRestoreDays] = useState<number>(DEFAULT_RESTORE_DAYS);
  const [retrievalTier, setRetrievalTier] = useState<RetrievalTier>(
    DEFAULT_RETRIEVAL_TIER
  );
  const [preview, setPreview] = useState<ThawResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const rangeValid =
    startDate !== null &&
    endDate !== null &&
    startDate.isValid() &&
    endDate.isValid() &&
    startDate.isSameOrBefore(endDate);
  const restoreDaysValid =
    Number.isInteger(restoreDays) &&
    restoreDays >= MIN_RESTORE_DAYS &&
    restoreDays <= MAX_RESTORE_DAYS;

  const buildBody = useCallback(
    (dry: boolean) =>
      JSON.stringify({
        start_date: toIso(startDate),
        end_date: toIso(endDate),
        restore_days: restoreDays,
        retrieval_tier: retrievalTier,
        dry_run: dry,
      }),
    [startDate, endDate, restoreDays, retrievalTier]
  );

  const doPreview = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const result = await http.post<ThawResult>(API.thaw, { body: buildBody(true) });
      setPreview(result);
    } catch (err) {
      setError(extractErrorMessage(err));
      setPreview(null);
    } finally {
      setRunning(false);
    }
  }, [http, buildBody]);

  const doRun = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const result = await http.post<ThawResult>(API.thaw, { body: buildBody(false) });
      if (result.request_id) {
        notifications.toasts.addSuccess({
          title: `Thaw initiated (${result.request_id.slice(0, 8)})`,
          text:
            `${result.repos.length} repo(s) thawing.` +
            (result.errors.length ? ` ${result.errors.length} warning(s).` : ''),
        });
      } else {
        notifications.toasts.addWarning({
          title: 'No repositories matched',
          text: 'No repositories overlap the selected date range.',
        });
      }
      onComplete();
      onClose();
    } catch (err) {
      const msg = extractErrorMessage(err);
      setError(msg);
      notifications.toasts.addDanger({ title: 'Thaw failed', text: msg });
    } finally {
      setRunning(false);
    }
  }, [http, buildBody, notifications, onComplete, onClose]);

  return (
    <EuiModal onClose={onClose} maxWidth={640}>
      <EuiModalHeader>
        <EuiModalHeaderTitle>Initiate a thaw request</EuiModalHeaderTitle>
      </EuiModalHeader>
      <EuiModalBody>
        <EuiText size="s" color="subdued">
          <p>
            Restores snapshot data from Glacier storage so that it can be re-mounted as
            searchable snapshots. Pick a UTC start and end (date plus optional time) and a
            restore window; deepfreeze will find every repository whose data overlaps the
            range, issue an S3 restore for each object, and create a thaw request you can
            monitor.
          </p>
        </EuiText>
        <EuiSpacer size="m" />
        <EuiForm component="div">
          <EuiFormRow
            label="Start (UTC)"
            helpText="Defaults to UTC midnight. Times are shown in 24-hour format."
          >
            <EuiDatePicker
              showTimeSelect
              selected={startDate}
              onChange={(d) => setStartDate(d)}
              utcOffset={0}
              dateFormat="YYYY-MM-DD HH:mm"
              timeFormat="HH:mm"
              maxDate={moment.utc()}
              fullWidth
            />
          </EuiFormRow>
          <EuiFormRow
            label="End (UTC)"
            helpText="Defaults to UTC midnight. For a full-day window, pick the next day's midnight as the end."
            isInvalid={
              startDate !== null &&
              endDate !== null &&
              endDate.isBefore(startDate)
            }
            error={
              startDate !== null &&
              endDate !== null &&
              endDate.isBefore(startDate)
                ? 'End must be on or after the start.'
                : undefined
            }
          >
            <EuiDatePicker
              showTimeSelect
              selected={endDate}
              onChange={(d) => setEndDate(d)}
              utcOffset={0}
              dateFormat="YYYY-MM-DD HH:mm"
              timeFormat="HH:mm"
              minDate={startDate ?? undefined}
              maxDate={moment.utc()}
              fullWidth
            />
          </EuiFormRow>
          <EuiFormRow
            label="Restore window (days)"
            helpText={`How long S3 keeps the restored copy available. ${MIN_RESTORE_DAYS}–${MAX_RESTORE_DAYS}. Sets the repository's expires_at.`}
            isInvalid={!restoreDaysValid}
            error={
              !restoreDaysValid
                ? `Must be an integer between ${MIN_RESTORE_DAYS} and ${MAX_RESTORE_DAYS}.`
                : undefined
            }
          >
            <EuiFieldNumber
              min={MIN_RESTORE_DAYS}
              max={MAX_RESTORE_DAYS}
              step={1}
              value={Number.isFinite(restoreDays) ? restoreDays : ''}
              onChange={(e) => setRestoreDays(Number(e.target.value))}
              fullWidth
            />
          </EuiFormRow>
          <EuiFormRow
            label="Retrieval tier"
            helpText="Latency vs cost tradeoff for the Glacier restore."
          >
            <EuiSelect
              options={TIER_OPTIONS}
              value={retrievalTier}
              onChange={(e) => setRetrievalTier(e.target.value as RetrievalTier)}
              fullWidth
            />
          </EuiFormRow>
        </EuiForm>

        {error && (
          <>
            <EuiSpacer size="m" />
            <EuiCallOut color="danger" iconType="alert" title="Thaw failed">
              <p>{error}</p>
            </EuiCallOut>
          </>
        )}

        {preview && !error && (
          <>
            <EuiSpacer size="m" />
            <EuiCallOut
              color={preview.repos.length === 0 ? 'warning' : 'success'}
              iconType={preview.repos.length === 0 ? 'alert' : 'check'}
              title={
                preview.repos.length === 0
                  ? 'No repositories overlap the selected range'
                  : `Preview — ${preview.repos.length} repositor${
                      preview.repos.length === 1 ? 'y' : 'ies'
                    } would be thawed`
              }
            >
              {preview.repos.length > 0 && (
                <p>
                  {preview.repos.map((name) => (
                    <EuiBadge key={name} color="hollow">
                      {name}
                    </EuiBadge>
                  ))}
                </p>
              )}
              <StepList steps={preview.steps} />
            </EuiCallOut>
          </>
        )}
      </EuiModalBody>
      <EuiModalFooter>
        <EuiButtonEmpty onClick={onClose} isDisabled={running}>
          Cancel
        </EuiButtonEmpty>
        <EuiButton
          onClick={doPreview}
          iconType="inspect"
          isLoading={running}
          isDisabled={!rangeValid || !restoreDaysValid}
        >
          Preview
        </EuiButton>
        <EuiButton
          fill
          onClick={doRun}
          iconType="play"
          isLoading={running}
          // The range must validate, but a preview is not required —
          // if the user already previewed and saw zero matches, keep
          // disabled; otherwise let them submit and toast the result.
          isDisabled={
            running ||
            !rangeValid ||
            !restoreDaysValid ||
            (preview !== null && preview.repos.length === 0)
          }
        >
          Initiate thaw
        </EuiButton>
      </EuiModalFooter>
    </EuiModal>
  );
}
