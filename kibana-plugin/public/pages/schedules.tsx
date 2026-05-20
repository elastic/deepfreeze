import React, { useCallback, useState } from 'react';
import {
  EuiBadge,
  EuiBasicTable,
  EuiButton,
  EuiButtonEmpty,
  EuiConfirmModal,
  EuiFlexGroup,
  EuiFlexItem,
  EuiSpacer,
  EuiText,
  EuiTitle,
  type EuiBasicTableColumn,
} from '@elastic/eui';
import type { CoreStart } from '@kbn/core/public';

import { useSchedules } from '../hooks/use_schedules';
import { ScheduleModal } from '../components/schedule_modal';
import { RefreshControl } from '../components/refresh_control';
import { PageLoading, PageError } from '../components/page_states';
import { formatTimestamp } from '../utils/format';
import type { ScheduledJobDoc } from '../../common/schemas/scheduled_job';

interface SchedulesPageProps {
  http: CoreStart['http'];
  notifications: CoreStart['notifications'];
}

/**
 * Format an interval (seconds) as a compact human string. Examples:
 *   60 → "1m", 3600 → "1h", 86400 → "1d", 7200 → "2h", 90 → "90s"
 */
function formatInterval(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return '—';
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function actionLabel(action: string): string {
  switch (action) {
    case 'rotate':
      return 'Rotate';
    case 'cleanup':
      return 'Cleanup';
    case 'repair':
    case 'repair_metadata':
      return 'Repair metadata';
    case 'update_date_ranges':
      return 'Update date ranges';
    default:
      return action;
  }
}

interface ApiError {
  body?: { message?: string };
  message?: string;
}
function extractErrorMessage(err: unknown): string {
  const e = err as ApiError;
  return e?.body?.message ?? e?.message ?? 'Unknown error';
}

export function SchedulesPage({ http, notifications }: SchedulesPageProps) {
  const {
    schedules,
    loading,
    error,
    refresh,
    createSchedule,
    updateSchedule,
    deleteSchedule,
    pauseSchedule,
    resumeSchedule,
    runScheduleNow,
  } = useSchedules(http);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ScheduledJobDoc | null>(null);
  const [deleting, setDeleting] = useState<ScheduledJobDoc | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // name being mutated

  const handlePauseResume = useCallback(
    async (job: ScheduledJobDoc) => {
      setBusy(job.name);
      try {
        if (job.paused) {
          await resumeSchedule(job.name);
          notifications.toasts.addSuccess({ title: `Resumed '${job.name}'` });
        } else {
          await pauseSchedule(job.name);
          notifications.toasts.addSuccess({ title: `Paused '${job.name}'` });
        }
      } catch (err) {
        notifications.toasts.addDanger({
          title: job.paused ? 'Resume failed' : 'Pause failed',
          text: extractErrorMessage(err),
        });
      } finally {
        setBusy(null);
      }
    },
    [pauseSchedule, resumeSchedule, notifications]
  );

  const handleRunNow = useCallback(
    async (job: ScheduledJobDoc) => {
      setBusy(job.name);
      try {
        await runScheduleNow(job.name);
        notifications.toasts.addSuccess({
          title: `Ran '${job.name}' (${actionLabel(job.action)})`,
          text: 'Check the Activity tab for the result.',
        });
      } catch (err) {
        notifications.toasts.addDanger({
          title: `Run failed: ${job.name}`,
          text: extractErrorMessage(err),
        });
      } finally {
        setBusy(null);
      }
    },
    [runScheduleNow, notifications]
  );

  const handleDelete = useCallback(async () => {
    if (!deleting) return;
    const name = deleting.name;
    setBusy(name);
    try {
      await deleteSchedule(name);
      notifications.toasts.addSuccess({ title: `Deleted '${name}'` });
    } catch (err) {
      notifications.toasts.addDanger({
        title: 'Delete failed',
        text: extractErrorMessage(err),
      });
    } finally {
      setBusy(null);
      setDeleting(null);
    }
  }, [deleting, deleteSchedule, notifications]);

  if (loading && schedules.length === 0) return <PageLoading />;
  if (error && schedules.length === 0)
    return <PageError message={error} onRetry={refresh} />;

  const columns: Array<EuiBasicTableColumn<ScheduledJobDoc>> = [
    {
      field: 'name',
      name: 'Name',
      sortable: true,
      render: (n: string) => <strong>{n}</strong>,
    },
    {
      field: 'action',
      name: 'Action',
      sortable: true,
      render: (a: string) => <EuiBadge color="hollow">{actionLabel(a)}</EuiBadge>,
    },
    {
      field: 'interval_seconds',
      name: 'Interval',
      sortable: true,
      render: (s: number | null) => formatInterval(s),
    },
    {
      field: 'paused',
      name: 'Status',
      sortable: true,
      render: (paused: boolean) => (
        <EuiBadge color={paused ? 'warning' : 'success'}>
          {paused ? 'Paused' : 'Active'}
        </EuiBadge>
      ),
    },
    {
      field: 'created_at',
      name: 'Created',
      sortable: true,
      render: (ts: string) => (ts ? formatTimestamp(ts) : '—'),
    },
    {
      name: 'Actions',
      actions: [
        {
          name: 'Pause/Resume',
          description: 'Toggle paused state',
          icon: (job: ScheduledJobDoc) => (job.paused ? 'play' : 'pause'),
          type: 'icon',
          onClick: handlePauseResume,
          isPrimary: true,
          'data-test-subj': 'schedule-pause-resume',
        },
        {
          name: 'Run now',
          description: 'Fire this action synchronously',
          icon: 'playFilled',
          type: 'icon',
          onClick: handleRunNow,
          'data-test-subj': 'schedule-run-now',
        },
        {
          name: 'Edit',
          description: 'Update interval, action, or params',
          icon: 'pencil',
          type: 'icon',
          onClick: (job: ScheduledJobDoc) => {
            setEditing(job);
            setModalOpen(true);
          },
          'data-test-subj': 'schedule-edit',
        },
        {
          name: 'Delete',
          description: 'Remove this schedule',
          icon: 'trash',
          type: 'icon',
          color: 'danger',
          onClick: (job: ScheduledJobDoc) => setDeleting(job),
          'data-test-subj': 'schedule-delete',
        },
      ],
    },
  ];

  return (
    <>
      <EuiFlexGroup justifyContent="spaceBetween" alignItems="center">
        <EuiFlexItem grow={false}>
          <EuiTitle size="m">
            <h2>Schedules</h2>
          </EuiTitle>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiFlexGroup gutterSize="s" alignItems="center">
            <EuiFlexItem grow={false}>
              <EuiButton
                iconType="plusInCircle"
                onClick={() => {
                  setEditing(null);
                  setModalOpen(true);
                }}
              >
                New schedule
              </EuiButton>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <RefreshControl onRefresh={refresh} loading={loading} />
            </EuiFlexItem>
          </EuiFlexGroup>
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiSpacer size="m" />

      <EuiBasicTable
        items={schedules}
        columns={columns}
        loading={!!busy}
        noItemsMessage={
          <EuiFlexGroup direction="column" alignItems="center" gutterSize="s">
            <EuiFlexItem>
              <EuiText size="s">No schedules yet.</EuiText>
            </EuiFlexItem>
            <EuiFlexItem>
              <EuiButtonEmpty
                iconType="plusInCircle"
                onClick={() => {
                  setEditing(null);
                  setModalOpen(true);
                }}
              >
                Create your first schedule
              </EuiButtonEmpty>
            </EuiFlexItem>
          </EuiFlexGroup>
        }
      />

      {modalOpen && (
        <ScheduleModal
          http={http}
          notifications={notifications}
          editing={editing}
          onClose={() => {
            setModalOpen(false);
            setEditing(null);
          }}
          onComplete={() => {
            setModalOpen(false);
            setEditing(null);
            refresh();
          }}
          createSchedule={createSchedule}
          updateSchedule={updateSchedule}
        />
      )}

      {deleting && (
        <EuiConfirmModal
          title={`Delete schedule '${deleting.name}'?`}
          onCancel={() => setDeleting(null)}
          onConfirm={handleDelete}
          cancelButtonText="Cancel"
          confirmButtonText="Delete"
          buttonColor="danger"
          defaultFocusedButton="cancel"
        >
          <p>
            The schedule will stop firing and its row will be removed from this list.
            Any audit history for prior runs is preserved.
          </p>
        </EuiConfirmModal>
      )}
    </>
  );
}
