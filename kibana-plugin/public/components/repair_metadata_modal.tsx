import React, { useCallback, useState } from 'react';
import {
  EuiBadge,
  EuiBasicTable,
  EuiButton,
  EuiButtonEmpty,
  EuiCallOut,
  EuiCode,
  EuiModal,
  EuiModalBody,
  EuiModalFooter,
  EuiModalHeader,
  EuiModalHeaderTitle,
  EuiSpacer,
  EuiText,
  type EuiBasicTableColumn,
} from '@elastic/eui';
import type { CoreStart } from '@kbn/core/public';

import { API } from '../../common/api/paths';
import type {
  DateRangeOutcome,
  DiscrepancyRecord,
  RepairResult,
} from '../../server/actions/repair_metadata';
import { trimDate } from '../utils/format';

interface RepairMetadataModalProps {
  http: CoreStart['http'];
  notifications: CoreStart['notifications'];
  onClose: () => void;
  onComplete: () => void;
}

interface ApiError {
  body?: { message?: string };
  message?: string;
}

function extractErrorMessage(err: unknown): string {
  const e = err as ApiError;
  return e?.body?.message ?? e?.message ?? 'Unknown error';
}

/**
 * Pick a badge color that reads at a glance: errors red, restoring warning,
 * everything else hollow. Purely cosmetic.
 */
function stateColor(s: string | null): 'danger' | 'warning' | 'primary' | 'hollow' {
  if (!s) return 'danger';
  if (s === 'thawing') return 'warning';
  if (s === 'frozen') return 'primary';
  return 'hollow';
}

/**
 * Renders the date-range repair outcomes. Different framing pre- vs
 * post-confirm:
 *   - Dry-run: "would query @timestamp for these repos"
 *   - Real-run: shows actual queried start/end (or skipped reasons)
 */
function DateRangesSection({
  items,
  completed,
}: {
  items: DateRangeOutcome[];
  completed: boolean;
}) {
  const changed = items.filter((d) => d.changed);
  const skipped = items.filter((d) => !d.changed);

  const columns: Array<EuiBasicTableColumn<DateRangeOutcome>> = [
    { field: 'repo', name: 'Repository' },
    {
      field: 'start',
      name: 'Start',
      render: (_: unknown, item: DateRangeOutcome) =>
        item.changed ? trimDate(item.start) || '--' : (
          <EuiText size="xs" color="subdued">
            {item.skipped_reason ?? '--'}
          </EuiText>
        ),
    },
    {
      field: 'end',
      name: 'End',
      render: (_: unknown, item: DateRangeOutcome) =>
        item.changed ? trimDate(item.end) || '--' : (
          <EuiText size="xs" color="subdued">
            --
          </EuiText>
        ),
    },
  ];

  return (
    <>
      <EuiCallOut
        color={completed && changed.length > 0 ? 'success' : 'primary'}
        iconType="calendar"
        title={
          completed
            ? `Set date range on ${changed.length} repositor${
                changed.length === 1 ? 'y' : 'ies'
              }${skipped.length > 0 ? ` (${skipped.length} skipped)` : ''}`
            : `${items.length} mounted repositor${
                items.length === 1 ? 'y is' : 'ies are'
              } missing date ranges`
        }
        size="s"
      >
        <p>
          Without a date range, deepfreeze can't find a repository for thawing
          by date. The repair queries each mounted repo's <EuiCode>@timestamp</EuiCode>
          range and populates <EuiCode>start</EuiCode> / <EuiCode>end</EuiCode>.
        </p>
      </EuiCallOut>
      <EuiSpacer size="s" />
      <EuiBasicTable items={items} columns={columns} />
    </>
  );
}

export function RepairMetadataModal({
  http,
  notifications,
  onClose,
  onComplete,
}: RepairMetadataModalProps) {
  const [preview, setPreview] = useState<RepairResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [completed, setCompleted] = useState<RepairResult | null>(null);

  const doPreview = useCallback(async () => {
    setRunning(true);
    setError(null);
    setCompleted(null);
    try {
      const result = await http.post<RepairResult>(API.repairMetadata, {
        body: JSON.stringify({ dry_run: true }),
      });
      setPreview(result);
    } catch (err) {
      setError(extractErrorMessage(err));
      setPreview(null);
    } finally {
      setRunning(false);
    }
  }, [http]);

  const doRun = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const result = await http.post<RepairResult>(API.repairMetadata, {
        body: JSON.stringify({ dry_run: false }),
      });
      setCompleted(result);
      const repairedCount = result.repaired.length;
      const failedCount = result.failed.length;
      const dateChangedCount = result.date_ranges.filter((d) => d.changed).length;

      const parts: string[] = [];
      if (repairedCount > 0) parts.push(`${repairedCount} state fix(es)`);
      if (dateChangedCount > 0) parts.push(`${dateChangedCount} date range(s)`);
      if (failedCount > 0) parts.push(`${failedCount} failure(s)`);

      if (repairedCount > 0 || dateChangedCount > 0) {
        notifications.toasts.addSuccess({
          title: 'Repair complete',
          text: parts.join(', '),
        });
      } else if (failedCount > 0) {
        notifications.toasts.addDanger({
          title: 'Repair failed',
          text: `${failedCount} repositor${
            failedCount === 1 ? 'y' : 'ies'
          } could not be persisted.`,
        });
      } else {
        notifications.toasts.addInfo({
          title: 'Nothing to repair',
          text: 'All repositories already reflect actual storage state and have date ranges set.',
        });
      }
      onComplete();
    } catch (err) {
      const msg = extractErrorMessage(err);
      setError(msg);
      notifications.toasts.addDanger({ title: 'Repair failed', text: msg });
    } finally {
      setRunning(false);
    }
  }, [http, notifications, onComplete]);

  const columns: Array<EuiBasicTableColumn<DiscrepancyRecord>> = [
    { field: 'repo', name: 'Repository' },
    {
      field: 'recorded_state',
      name: 'Recorded',
      render: (s: string) => (
        <EuiBadge color={stateColor(s)}>{s}</EuiBadge>
      ),
    },
    {
      field: 'actual_state',
      name: 'Actual',
      render: (s: string | null, item: DiscrepancyRecord) => {
        if (item.error) {
          return (
            <EuiText size="xs" color="danger">
              error
            </EuiText>
          );
        }
        return <EuiBadge color={stateColor(s)}>{s ?? '--'}</EuiBadge>;
      },
    },
    {
      field: 'total_objects',
      name: 'Objects',
      render: (_: unknown, item: DiscrepancyRecord) =>
        item.error ? (
          <EuiText size="xs" color="subdued">
            --
          </EuiText>
        ) : (
          <EuiText size="xs">
            {item.instant_access} hot / {item.glacier} cold
            {item.restoring > 0 ? ` / ${item.restoring} restoring` : ''}
          </EuiText>
        ),
    },
  ];

  const view: RepairResult | null = completed ?? preview;

  return (
    <EuiModal onClose={onClose} maxWidth={780}>
      <EuiModalHeader>
        <EuiModalHeaderTitle>Repair repository metadata</EuiModalHeaderTitle>
      </EuiModalHeader>
      <EuiModalBody>
        <EuiText size="s" color="subdued">
          <p>
            Scans each repository's actual S3 storage state and flags any disagreement
            with the recorded <EuiCode>thaw_state</EuiCode>. Useful when lifecycle
            policies or manual S3 ops have moved objects without deepfreeze noticing.
          </p>
          <p>
            <strong>Run the preview first</strong> to see proposed changes; nothing is
            written until you confirm.
          </p>
        </EuiText>

        {error && (
          <>
            <EuiSpacer size="m" />
            <EuiCallOut color="danger" iconType="alert" title="Repair failed">
              <p>{error}</p>
            </EuiCallOut>
          </>
        )}

        {view && !error && (
          <>
            <EuiSpacer size="m" />
            {view.discrepancies.length === 0 && view.date_ranges.length === 0 ? (
              <EuiCallOut
                color="success"
                iconType="check"
                title="Nothing to repair"
                size="s"
              >
                <p>
                  Every repository's recorded state matches actual S3 storage and all
                  mounted repos have date ranges set.
                </p>
              </EuiCallOut>
            ) : (
              <>
                {view.discrepancies.length > 0 && (
                  <>
                    <EuiCallOut
                      color={completed ? 'success' : 'warning'}
                      iconType={completed ? 'check' : 'alert'}
                      title={
                        completed
                          ? `Repaired ${completed.repaired.length} of ${view.discrepancies.length} state discrepanc${
                              view.discrepancies.length === 1 ? 'y' : 'ies'
                            }`
                          : `${view.discrepancies.length} state discrepanc${
                              view.discrepancies.length === 1 ? 'y' : 'ies'
                            } found`
                      }
                      size="s"
                    />
                    <EuiSpacer size="s" />
                    <EuiBasicTable items={view.discrepancies} columns={columns} />
                  </>
                )}

                {view.date_ranges.length > 0 && (
                  <>
                    <EuiSpacer size="m" />
                    <DateRangesSection items={view.date_ranges} completed={!!completed} />
                  </>
                )}

                {view.failed.length > 0 && (
                  <>
                    <EuiSpacer size="s" />
                    <EuiCallOut
                      color="danger"
                      iconType="alert"
                      title={`${view.failed.length} failure(s)`}
                      size="s"
                    >
                      <ul>
                        {view.failed.map((f) => (
                          <li key={f.repo}>
                            <code>{f.repo}</code>: {f.error ?? 'unknown'}
                          </li>
                        ))}
                      </ul>
                    </EuiCallOut>
                  </>
                )}
              </>
            )}
          </>
        )}
      </EuiModalBody>
      <EuiModalFooter>
        <EuiButtonEmpty onClick={onClose} isDisabled={running}>
          {completed ? 'Close' : 'Cancel'}
        </EuiButtonEmpty>
        <EuiButton onClick={doPreview} iconType="inspect" isLoading={running}>
          Preview
        </EuiButton>
        <EuiButton
          fill
          onClick={doRun}
          iconType="wrench"
          isLoading={running}
          isDisabled={
            !preview ||
            (preview.discrepancies.length === 0 && preview.date_ranges.length === 0) ||
            !!completed
          }
        >
          Apply repairs
        </EuiButton>
      </EuiModalFooter>
    </EuiModal>
  );
}
