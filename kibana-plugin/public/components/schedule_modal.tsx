import React, { useCallback, useMemo, useState } from 'react';
import {
  EuiButton,
  EuiButtonEmpty,
  EuiCallOut,
  EuiCheckbox,
  EuiFieldNumber,
  EuiFieldText,
  EuiFlexGroup,
  EuiFlexItem,
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

import type { ScheduledJobDoc } from '../../common/schemas/scheduled_job';

/** Action options surfaced in the dropdown — matches the server enum. */
const ACTION_OPTIONS: Array<{ value: ScheduledAction; text: string }> = [
  { value: 'rotate', text: 'Rotate' },
  { value: 'cleanup', text: 'Cleanup' },
  { value: 'repair_metadata', text: 'Repair metadata' },
];

type ScheduledAction = 'rotate' | 'cleanup' | 'repair_metadata';

/** Interval units exposed in the UI; stored on the doc as seconds. */
const UNIT_OPTIONS: Array<{ value: IntervalUnit; text: string }> = [
  { value: 'minutes', text: 'minutes' },
  { value: 'hours', text: 'hours' },
  { value: 'days', text: 'days' },
];

type IntervalUnit = 'minutes' | 'hours' | 'days';

const UNIT_SECONDS: Record<IntervalUnit, number> = {
  minutes: 60,
  hours: 3600,
  days: 86400,
};

/**
 * Pick a sensible (value, unit) pair for a given second count by
 * choosing the largest unit that yields an integer value. Defaults to
 * hours when the value doesn't divide cleanly into any of our units.
 */
function secondsToInterval(seconds: number): {
  value: number;
  unit: IntervalUnit;
} {
  if (seconds % UNIT_SECONDS.days === 0) {
    return { value: seconds / UNIT_SECONDS.days, unit: 'days' };
  }
  if (seconds % UNIT_SECONDS.hours === 0) {
    return { value: seconds / UNIT_SECONDS.hours, unit: 'hours' };
  }
  if (seconds % UNIT_SECONDS.minutes === 0) {
    return { value: seconds / UNIT_SECONDS.minutes, unit: 'minutes' };
  }
  // Fall back to minutes-rounded display; the actual value persists
  // as-is when the user edits without changing the interval.
  return { value: Math.max(1, Math.round(seconds / 60)), unit: 'minutes' };
}

interface ScheduleModalProps {
  http: CoreStart['http'];
  notifications: CoreStart['notifications'];
  /** When set, the modal opens in edit mode pre-populated with this doc. */
  editing?: ScheduledJobDoc | null;
  onClose: () => void;
  onComplete: () => void;
  /** Mutators wired up by the parent (typically from useSchedules). */
  createSchedule: (body: {
    name: string;
    action: ScheduledAction;
    params?: Record<string, unknown>;
    interval_seconds: number;
    paused?: boolean;
  }) => Promise<ScheduledJobDoc>;
  updateSchedule: (
    name: string,
    patch: {
      action?: ScheduledAction;
      params?: Record<string, unknown>;
      interval_seconds?: number;
      paused?: boolean;
    }
  ) => Promise<ScheduledJobDoc>;
}

interface ApiError {
  body?: { message?: string };
  message?: string;
}

function extractErrorMessage(err: unknown): string {
  const e = err as ApiError;
  return e?.body?.message ?? e?.message ?? 'Unknown error';
}

export function ScheduleModal({
  http: _http,
  notifications,
  editing,
  onClose,
  onComplete,
  createSchedule,
  updateSchedule,
}: ScheduleModalProps) {
  const isEdit = !!editing;

  const initialInterval = useMemo(
    () =>
      editing
        ? secondsToInterval(editing.interval_seconds ?? 3600)
        : { value: 1, unit: 'days' as IntervalUnit },
    [editing]
  );

  const [name, setName] = useState(editing?.name ?? '');
  const [action, setAction] = useState<ScheduledAction>(
    (editing?.action as ScheduledAction) ?? 'rotate'
  );
  const [intervalValue, setIntervalValue] = useState(String(initialInterval.value));
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>(initialInterval.unit);
  const [keep, setKeep] = useState(
    String((editing?.params?.keep as number | undefined) ?? 6)
  );
  const [paused, setPaused] = useState(editing?.paused ?? false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const intervalSeconds = useMemo(() => {
    const v = Number(intervalValue);
    if (!Number.isFinite(v) || v <= 0) return 0;
    return Math.round(v * UNIT_SECONDS[intervalUnit]);
  }, [intervalValue, intervalUnit]);

  const nameValid = isEdit || /^[A-Za-z0-9_-]+$/.test(name);
  const intervalValid = intervalSeconds > 0;
  const keepValid =
    action !== 'rotate' || (Number.isFinite(Number(keep)) && Number(keep) >= 0);
  const canSubmit = nameValid && intervalValid && keepValid && !submitting;

  const submit = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const params: Record<string, unknown> | undefined =
        action === 'rotate' ? { keep: Number(keep) } : undefined;

      if (isEdit) {
        await updateSchedule(editing!.name, {
          action,
          params,
          interval_seconds: intervalSeconds,
          paused,
        });
        notifications.toasts.addSuccess({
          title: `Schedule '${editing!.name}' updated`,
        });
      } else {
        await createSchedule({
          name,
          action,
          params,
          interval_seconds: intervalSeconds,
          paused,
        });
        notifications.toasts.addSuccess({
          title: `Schedule '${name}' created`,
        });
      }
      onComplete();
      onClose();
    } catch (err) {
      const msg = extractErrorMessage(err);
      setError(msg);
      notifications.toasts.addDanger({
        title: isEdit ? 'Update failed' : 'Create failed',
        text: msg,
      });
    } finally {
      setSubmitting(false);
    }
  }, [
    isEdit,
    name,
    action,
    keep,
    intervalSeconds,
    paused,
    createSchedule,
    updateSchedule,
    editing,
    notifications,
    onComplete,
    onClose,
  ]);

  return (
    <EuiModal onClose={onClose} maxWidth={640}>
      <EuiModalHeader>
        <EuiModalHeaderTitle>
          {isEdit ? `Edit schedule '${editing!.name}'` : 'New schedule'}
        </EuiModalHeaderTitle>
      </EuiModalHeader>
      <EuiModalBody>
        <EuiText size="s" color="subdued">
          <p>
            Scheduled jobs fire on a fixed interval. Deepfreeze supports rotating
            repositories, running cleanup, and reconciling repository metadata on a
            schedule. Use Pause/Resume on the row to toggle a job without losing its
            configuration.
          </p>
        </EuiText>
        <EuiSpacer size="m" />

        <EuiForm component="div">
          <EuiFormRow
            label="Name"
            helpText="Letters, digits, dashes, and underscores. Immutable after creation."
            isInvalid={!isEdit && name.length > 0 && !nameValid}
            error={
              !isEdit && name.length > 0 && !nameValid
                ? 'Allowed: A–Z, a–z, 0–9, dash, underscore'
                : undefined
            }
          >
            <EuiFieldText
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isEdit}
              placeholder="nightly-rotate"
            />
          </EuiFormRow>

          <EuiFormRow label="Action">
            <EuiSelect
              options={ACTION_OPTIONS}
              value={action}
              onChange={(e) => setAction(e.target.value as ScheduledAction)}
            />
          </EuiFormRow>

          <EuiFormRow label="Run every">
            <EuiFlexGroup>
              <EuiFlexItem>
                <EuiFieldNumber
                  min={1}
                  value={intervalValue}
                  onChange={(e) => setIntervalValue(e.target.value)}
                />
              </EuiFlexItem>
              <EuiFlexItem>
                <EuiSelect
                  options={UNIT_OPTIONS}
                  value={intervalUnit}
                  onChange={(e) => setIntervalUnit(e.target.value as IntervalUnit)}
                />
              </EuiFlexItem>
            </EuiFlexGroup>
          </EuiFormRow>

          {action === 'rotate' && (
            <EuiFormRow
              label="Keep"
              helpText="Number of newest active repositories to keep mounted after each rotation."
              isInvalid={!keepValid}
              error={!keepValid ? 'Must be a non-negative number' : undefined}
            >
              <EuiFieldNumber
                min={0}
                value={keep}
                onChange={(e) => setKeep(e.target.value)}
              />
            </EuiFormRow>
          )}

          <EuiSpacer size="s" />
          <EuiCheckbox
            id="schedule-paused"
            label="Create paused"
            checked={paused}
            onChange={(e) => setPaused(e.target.checked)}
          />
        </EuiForm>

        {error && (
          <>
            <EuiSpacer size="m" />
            <EuiCallOut color="danger" iconType="alert" title="Operation failed">
              <p>{error}</p>
            </EuiCallOut>
          </>
        )}
      </EuiModalBody>
      <EuiModalFooter>
        <EuiButtonEmpty onClick={onClose} isDisabled={submitting}>
          Cancel
        </EuiButtonEmpty>
        <EuiButton
          fill
          onClick={submit}
          iconType={isEdit ? 'save' : 'plusInCircle'}
          isLoading={submitting}
          isDisabled={!canSubmit}
        >
          {isEdit ? 'Save changes' : 'Create schedule'}
        </EuiButton>
      </EuiModalFooter>
    </EuiModal>
  );
}

