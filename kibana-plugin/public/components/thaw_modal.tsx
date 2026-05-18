import React, { useCallback, useMemo, useState } from 'react';
import {
  EuiBadge,
  EuiButton,
  EuiButtonEmpty,
  EuiCallOut,
  EuiFieldText,
  EuiForm,
  EuiFormRow,
  EuiModal,
  EuiModalBody,
  EuiModalFooter,
  EuiModalHeader,
  EuiModalHeaderTitle,
  EuiSpacer,
  EuiText,
} from '@elastic/eui';
import type { CoreStart } from '@kbn/core/public';

import { API } from '../../common/api/paths';
import { StepList } from './step_list';
import type { ThawResult } from '../../server/actions/thaw';

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
 * Promote a YYYY-MM-DD value from `<input type="date">` to an ISO 8601
 * timestamp. Start dates clamp to 00:00:00Z; end dates to 23:59:59Z so
 * a user-picked single day actually spans the whole day server-side.
 */
function toIso(date: string, kind: 'start' | 'end'): string {
  const suffix = kind === 'start' ? 'T00:00:00.000Z' : 'T23:59:59.999Z';
  return `${date}${suffix}`;
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
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [preview, setPreview] = useState<ThawResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const rangeValid =
    startDate !== '' && endDate !== '' && startDate <= endDate;

  const buildBody = useCallback(
    (dry: boolean) =>
      JSON.stringify({
        start_date: toIso(startDate, 'start'),
        end_date: toIso(endDate, 'end'),
        dry_run: dry,
      }),
    [startDate, endDate]
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
            searchable snapshots. Pick a date range; deepfreeze will find every repository whose
            data overlaps the range, restore each object (default lifetime: 7 days, Standard
            retrieval tier), and create a thaw request you can monitor.
          </p>
        </EuiText>
        <EuiSpacer size="m" />
        <EuiForm component="div">
          <EuiFormRow label="Start date" helpText="Inclusive — UTC midnight.">
            <EuiFieldText
              // EuiFieldText doesn't expose `type` directly in its props,
              // but it forwards extra HTML attributes onto the underlying input.
              {...({ type: 'date' } as { type: string })}
              max={today}
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              fullWidth
            />
          </EuiFormRow>
          <EuiFormRow
            label="End date"
            helpText="Inclusive — UTC end of day."
            isInvalid={startDate !== '' && endDate !== '' && endDate < startDate}
            error={
              startDate !== '' && endDate !== '' && endDate < startDate
                ? 'End date must be on or after the start date.'
                : undefined
            }
          >
            <EuiFieldText
              {...({ type: 'date' } as { type: string })}
              max={today}
              min={startDate || undefined}
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
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
          isDisabled={!rangeValid}
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
            (preview !== null && preview.repos.length === 0)
          }
        >
          Initiate thaw
        </EuiButton>
      </EuiModalFooter>
    </EuiModal>
  );
}
