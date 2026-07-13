import { useState, useEffect, useCallback } from 'react';
import {
  EuiBasicTable,
  EuiBadge,
  EuiButton,
  EuiButtonEmpty,
  EuiButtonIcon,
  EuiFieldNumber,
  EuiFieldText,
  EuiFlexGroup,
  EuiFlexItem,
  EuiForm,
  EuiFormRow,
  EuiGlobalToastList,
  EuiModal,
  EuiModalBody,
  EuiModalFooter,
  EuiModalHeader,
  EuiModalHeaderTitle,
  EuiPanel,
  EuiSelect,
  EuiSpacer,
  EuiSwitch,
  EuiText,
  EuiTitle,
  EuiToolTip,
  EuiConfirmModal,
  EuiCallOut,
  EuiCode,
  type EuiBasicTableColumn,
} from '@elastic/eui';
import { api, type ScheduledJob } from '../api/client';
import RefreshControl from '../components/RefreshControl';

// -- Schedule mode types --

type ScheduleMode = 'interval' | 'day_of_month' | 'day_of_week' | 'cron';
type IntervalUnit = 'hours' | 'days' | 'weeks' | 'months';

interface ScheduleModeOption {
  value: ScheduleMode;
  text: string;
}

const scheduleModes: ScheduleModeOption[] = [
  { value: 'interval', text: 'Every N ...' },
  { value: 'day_of_month', text: 'Day of each month' },
  { value: 'day_of_week', text: 'Day of the week' },
  { value: 'cron', text: 'Cron expression (advanced)' },
];

const intervalUnits: { value: IntervalUnit; text: string }[] = [
  { value: 'hours', text: 'hours' },
  { value: 'days', text: 'days' },
  { value: 'weeks', text: 'weeks' },
  { value: 'months', text: 'months' },
];

const weekdays = [
  { value: '1', text: 'Monday' },
  { value: '2', text: 'Tuesday' },
  { value: '3', text: 'Wednesday' },
  { value: '4', text: 'Thursday' },
  { value: '5', text: 'Friday' },
  { value: '6', text: 'Saturday' },
  { value: '0', text: 'Sunday' },
];

const jobActions = [
  { value: 'rotate', text: 'Rotate' },
  { value: 'cleanup', text: 'Cleanup' },
  { value: 'thaw_check', text: 'Check Thaw Status' },
  { value: 'repair', text: 'Repair Metadata' },
  { value: 'refreeze', text: 'Refreeze' },
  { value: 'update_date_ranges', text: 'Update Date Ranges' },
];

const UNIT_SECONDS: Record<IntervalUnit, number> = {
  hours: 3600,
  days: 86400,
  weeks: 604800,
  months: 2592000, // 30 days
};

function intervalToSeconds(n: number, unit: IntervalUnit): number {
  return n * UNIT_SECONDS[unit];
}

/** Try to decompose interval_seconds into a friendly (N, unit) pair. */
function secondsToInterval(secs: number): { n: number; unit: IntervalUnit } {
  // Try largest unit first
  for (const unit of ['months', 'weeks', 'days', 'hours'] as IntervalUnit[]) {
    const factor = UNIT_SECONDS[unit];
    if (secs >= factor && secs % factor === 0) {
      return { n: secs / factor, unit };
    }
  }
  return { n: Math.round(secs / 3600), unit: 'hours' };
}

function buildCron(mode: ScheduleMode, values: { dayOfMonth?: number; dayOfWeek?: string; hour?: number; minute?: number; cron?: string }): string | null {
  const h = values.hour ?? 2;
  const m = values.minute ?? 0;
  switch (mode) {
    case 'interval':
      return null; // interval-based, use interval_seconds
    case 'day_of_month':
      return `${m} ${h} ${values.dayOfMonth ?? 1} * *`;
    case 'day_of_week':
      return `${m} ${h} * * ${values.dayOfWeek ?? '1'}`;
    case 'cron':
      return values.cron || null;
  }
}

function describeCron(cron: string | null, intervalSeconds: number | null): string {
  if (intervalSeconds != null && intervalSeconds > 0) {
    const { n, unit } = secondsToInterval(intervalSeconds);
    const label = n === 1 ? unit.replace(/s$/, '') : unit;
    return `Every ${n} ${label}`;
  }
  if (!cron) return '--';
  const parts = cron.split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, dom, , dow] = parts;

  if (dom === '*' && dow !== '*') {
    const day = weekdays.find(w => w.value === dow);
    return `Every ${day?.text ?? `weekday ${dow}`} at ${hour}:${min.padStart(2, '0')}`;
  }
  if (dom !== '*' && dow === '*') {
    const suffix = dom === '1' || dom === '21' || dom === '31' ? 'st' : dom === '2' || dom === '22' ? 'nd' : dom === '3' || dom === '23' ? 'rd' : 'th';
    return `${dom}${suffix} of each month at ${hour}:${min.padStart(2, '0')}`;
  }
  return cron;
}

/** Infer schedule mode from a ScheduledJob for pre-populating the edit form. */
function inferScheduleMode(job: ScheduledJob): ScheduleMode {
  if (job.interval_seconds != null && job.interval_seconds > 0) return 'interval';
  if (!job.cron) return 'cron';
  const parts = job.cron.split(/\s+/);
  if (parts.length !== 5) return 'cron';
  const [, , dom, , dow] = parts;
  if (dom !== '*' && dow === '*') return 'day_of_month';
  if (dom === '*' && dow !== '*') return 'day_of_week';
  return 'cron';
}

interface Toast {
  id: string;
  title: string;
  color: 'success' | 'danger' | 'warning';
  text?: string;
}

export default function Scheduler() {
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [modalMode, setModalMode] = useState<'add' | 'edit' | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null); // original name when editing
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  // Form state
  const [jobName, setJobName] = useState('');
  const [jobAction, setJobAction] = useState('rotate');
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>('day_of_month');
  const [intervalN, setIntervalN] = useState(30);
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>('days');
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [dayOfWeek, setDayOfWeek] = useState('5');
  const [hour, setHour] = useState(2);
  const [minute, setMinute] = useState(0);
  const [cronExpr, setCronExpr] = useState('');
  const [keepParam, setKeepParam] = useState(6);
  const [showParams, setShowParams] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const addToast = useCallback((title: string, color: Toast['color'], text?: string) => {
    setToasts(prev => [...prev, { id: String(Date.now()), title, color, text }]);
  }, []);

  const fetchJobs = useCallback(async () => {
    setFetchError(null);
    try {
      const data = await api.getScheduledJobs();
      setJobs(data.jobs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setFetchError(msg);
      addToast('Failed to load scheduled jobs', 'danger', msg);
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => { fetchJobs(); }, [fetchJobs]);

  const resetForm = () => {
    setJobName('');
    setJobAction('rotate');
    setScheduleMode('day_of_month');
    setIntervalN(30);
    setIntervalUnit('days');
    setDayOfMonth(1);
    setDayOfWeek('5');
    setHour(2);
    setMinute(0);
    setCronExpr('');
    setKeepParam(6);
    setShowParams(false);
    setEditingName(null);
  };

  const openAdd = () => {
    resetForm();
    setModalMode('add');
  };

  const openEdit = (job: ScheduledJob) => {
    setEditingName(job.name);
    setJobName(job.name);
    setJobAction(job.action);

    const mode = inferScheduleMode(job);
    setScheduleMode(mode);

    if (mode === 'interval' && job.interval_seconds) {
      const { n, unit } = secondsToInterval(job.interval_seconds);
      setIntervalN(n);
      setIntervalUnit(unit);
    }
    if (mode === 'day_of_month' && job.cron) {
      const parts = job.cron.split(/\s+/);
      setMinute(Number(parts[0]) || 0);
      setHour(Number(parts[1]) || 2);
      setDayOfMonth(Number(parts[2]) || 1);
    }
    if (mode === 'day_of_week' && job.cron) {
      const parts = job.cron.split(/\s+/);
      setMinute(Number(parts[0]) || 0);
      setHour(Number(parts[1]) || 2);
      setDayOfWeek(parts[4] || '1');
    }
    if (mode === 'cron' && job.cron) {
      setCronExpr(job.cron);
    }

    const keep = job.params?.keep;
    if (typeof keep === 'number') {
      setKeepParam(keep);
      setShowParams(true);
    } else {
      setKeepParam(6);
      setShowParams(false);
    }

    setModalMode('edit');
  };

  const closeModal = () => {
    setModalMode(null);
    resetForm();
  };

  const buildRequest = () => {
    const params: Record<string, unknown> = {};
    if (jobAction === 'rotate' && showParams && keepParam > 0) params.keep = keepParam;

    if (scheduleMode === 'interval') {
      return {
        name: jobName.trim(),
        action: jobAction,
        params,
        interval_seconds: intervalToSeconds(intervalN, intervalUnit),
      };
    }
    const cron = buildCron(scheduleMode, { dayOfMonth, dayOfWeek, hour, minute, cron: cronExpr });
    if (!cron) return null;
    return {
      name: jobName.trim(),
      action: jobAction,
      params,
      cron,
    };
  };

  const handleSubmit = async () => {
    if (!jobName.trim()) { addToast('Name is required', 'warning'); return; }
    const req = buildRequest();
    if (!req) { addToast('Invalid schedule', 'warning'); return; }

    setSubmitting(true);
    try {
      if (modalMode === 'edit' && editingName) {
        await api.updateScheduledJob(editingName, req);
        addToast(`Updated "${req.name}"`, 'success');
      } else {
        await api.addScheduledJob(req);
        addToast(`Added "${req.name}"`, 'success');
      }
      closeModal();
      await fetchJobs();
    } catch (err) {
      addToast(`Failed to ${modalMode} job`, 'danger', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleTogglePause = async (job: ScheduledJob) => {
    try {
      if (job.paused) {
        await api.resumeScheduledJob(job.name);
        addToast(`Resumed "${job.name}"`, 'success');
      } else {
        await api.pauseScheduledJob(job.name);
        addToast(`Paused "${job.name}"`, 'success');
      }
      await fetchJobs();
    } catch (err) {
      addToast('Action failed', 'danger', err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await api.removeScheduledJob(deleteTarget);
      addToast(`Removed "${deleteTarget}"`, 'success');
      setDeleteTarget(null);
      await fetchJobs();
    } catch (err) {
      addToast('Failed to remove job', 'danger', err instanceof Error ? err.message : 'Unknown error');
      setDeleteTarget(null);
    }
  };

  const getPreview = (): string => {
    if (scheduleMode === 'interval') {
      const label = intervalN === 1 ? intervalUnit.replace(/s$/, '') : intervalUnit;
      return `Every ${intervalN} ${label}`;
    }
    const cron = buildCron(scheduleMode, { dayOfMonth, dayOfWeek, hour, minute, cron: cronExpr });
    if (!cron) return '--';
    if (scheduleMode === 'cron') return cron;
    return describeCron(cron, null);
  };

  const columns: EuiBasicTableColumn<ScheduledJob>[] = [
    {
      field: 'name',
      name: 'Name',
      sortable: true,
      render: (name: string, job: ScheduledJob) => (
        <EuiFlexGroup alignItems="center" gutterSize="s" responsive={false}>
          <EuiFlexItem grow={false}>
            <strong>{name}</strong>
          </EuiFlexItem>
          {!job.persisted && (
            <EuiFlexItem grow={false}>
              <EuiBadge color="default">Built-in</EuiBadge>
            </EuiFlexItem>
          )}
          {job.paused && (
            <EuiFlexItem grow={false}>
              <EuiBadge color="warning">Paused</EuiBadge>
            </EuiFlexItem>
          )}
        </EuiFlexGroup>
      ),
    },
    {
      field: 'action',
      name: 'Action',
      sortable: true,
      render: (action: string) => {
        const label = jobActions.find(a => a.value === action)?.text ?? action;
        return <EuiBadge color="hollow">{label}</EuiBadge>;
      },
    },
    {
      name: 'Schedule',
      render: (job: ScheduledJob) => describeCron(job.cron, job.interval_seconds),
    },
    {
      name: 'Cron',
      render: (job: ScheduledJob) => job.cron ? <EuiCode>{job.cron}</EuiCode> : <EuiText size="s" color="subdued">interval</EuiText>,
      width: '140px',
    },
    {
      field: 'next_run',
      name: 'Next Run',
      render: (next: string | null) => next ? new Date(next).toLocaleString() : '--',
    },
    {
      name: 'Actions',
      width: '130px',
      actions: [
        {
          name: 'Edit',
          description: 'Edit job',
          render: (job: ScheduledJob) =>
            job.persisted ? (
              <EuiToolTip content="Edit">
                <EuiButtonIcon
                  iconType="pencil"
                  aria-label="Edit"
                  color="primary"
                  onClick={() => openEdit(job)}
                />
              </EuiToolTip>
            ) : (
              <EuiToolTip content="Built-in jobs cannot be edited">
                <EuiButtonIcon
                  iconType="pencil"
                  aria-label="Edit (disabled)"
                  color="text"
                  isDisabled
                />
              </EuiToolTip>
            ),
        },
        {
          name: 'Toggle',
          description: 'Pause or resume',
          render: (job: ScheduledJob) => (
            <EuiToolTip content={job.paused ? 'Resume' : 'Pause'}>
              <EuiButtonIcon
                iconType={job.paused ? 'playFilled' : 'pause'}
                aria-label={job.paused ? 'Resume' : 'Pause'}
                color={job.paused ? 'success' : 'warning'}
                onClick={() => handleTogglePause(job)}
              />
            </EuiToolTip>
          ),
        },
        {
          name: 'Delete',
          description: 'Remove job',
          render: (job: ScheduledJob) =>
            job.persisted ? (
              <EuiToolTip content="Remove">
                <EuiButtonIcon
                  iconType="trash"
                  aria-label="Remove"
                  color="danger"
                  onClick={() => setDeleteTarget(job.name)}
                />
              </EuiToolTip>
            ) : (
              <EuiToolTip content="Built-in jobs cannot be removed">
                <EuiButtonIcon
                  iconType="trash"
                  aria-label="Remove (disabled)"
                  color="text"
                  isDisabled
                />
              </EuiToolTip>
            ),
        },
      ],
    },
  ];

  return (
    <>
      <EuiFlexGroup justifyContent="spaceBetween" alignItems="center">
        <EuiFlexItem grow={false}>
          <EuiTitle size="l"><h2>Scheduler</h2></EuiTitle>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiFlexGroup gutterSize="m" alignItems="center" responsive={false}>
            <EuiFlexItem grow={false}>
              <RefreshControl onRefresh={fetchJobs} loading={loading} defaultInterval={0} />
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiButton iconType="plusInCircle" fill onClick={openAdd}>
                Add Scheduled Job
              </EuiButton>
            </EuiFlexItem>
          </EuiFlexGroup>
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiSpacer size="l" />

      {fetchError && (
        <>
          <EuiCallOut title="Failed to load scheduled jobs" color="danger" iconType="warning">
            <p>{fetchError}</p>
          </EuiCallOut>
          <EuiSpacer size="l" />
        </>
      )}

      <EuiPanel hasBorder>
        <EuiBasicTable<ScheduledJob>
          items={jobs}
          columns={columns}
          loading={loading}
          noItemsMessage="No scheduled jobs configured."
          rowHeader="name"
        />
      </EuiPanel>

      {/* Add / Edit Job Modal */}
      {modalMode && (
        <EuiModal onClose={closeModal} style={{ width: 540 }}>
          <EuiModalHeader>
            <EuiModalHeaderTitle>
              {modalMode === 'edit' ? 'Edit Scheduled Job' : 'Add Scheduled Job'}
            </EuiModalHeaderTitle>
          </EuiModalHeader>
          <EuiModalBody>
            <EuiForm>
              <EuiFormRow label="Job name" helpText="A unique identifier for this schedule.">
                <EuiFieldText
                  value={jobName}
                  onChange={e => setJobName(e.target.value)}
                  placeholder="e.g., monthly-rotate"
                />
              </EuiFormRow>

              <EuiFormRow label="Action">
                <EuiSelect
                  options={jobActions}
                  value={jobAction}
                  onChange={e => setJobAction(e.target.value)}
                />
              </EuiFormRow>

              <EuiSpacer size="m" />

              <EuiFormRow label="Schedule type">
                <EuiSelect
                  options={scheduleModes}
                  value={scheduleMode}
                  onChange={e => setScheduleMode(e.target.value as ScheduleMode)}
                />
              </EuiFormRow>

              {scheduleMode === 'interval' && (
                <EuiFlexGroup gutterSize="m">
                  <EuiFlexItem>
                    <EuiFormRow label="Every">
                      <EuiFieldNumber value={intervalN} onChange={e => setIntervalN(Number(e.target.value))} min={1} max={999} />
                    </EuiFormRow>
                  </EuiFlexItem>
                  <EuiFlexItem>
                    <EuiFormRow label="Unit">
                      <EuiSelect
                        options={intervalUnits}
                        value={intervalUnit}
                        onChange={e => setIntervalUnit(e.target.value as IntervalUnit)}
                      />
                    </EuiFormRow>
                  </EuiFlexItem>
                </EuiFlexGroup>
              )}

              {scheduleMode === 'day_of_month' && (
                <EuiFormRow label="Day of the month" helpText="1-31. The job runs on this day each month.">
                  <EuiFieldNumber value={dayOfMonth} onChange={e => setDayOfMonth(Number(e.target.value))} min={1} max={31} />
                </EuiFormRow>
              )}

              {scheduleMode === 'day_of_week' && (
                <EuiFormRow label="Day of the week">
                  <EuiSelect options={weekdays} value={dayOfWeek} onChange={e => setDayOfWeek(e.target.value)} />
                </EuiFormRow>
              )}

              {(scheduleMode === 'day_of_month' || scheduleMode === 'day_of_week') && (
                <EuiFlexGroup gutterSize="m">
                  <EuiFlexItem>
                    <EuiFormRow label="Hour (0-23)">
                      <EuiFieldNumber value={hour} onChange={e => setHour(Number(e.target.value))} min={0} max={23} />
                    </EuiFormRow>
                  </EuiFlexItem>
                  <EuiFlexItem>
                    <EuiFormRow label="Minute (0-59)">
                      <EuiFieldNumber value={minute} onChange={e => setMinute(Number(e.target.value))} min={0} max={59} />
                    </EuiFormRow>
                  </EuiFlexItem>
                </EuiFlexGroup>
              )}

              {scheduleMode === 'cron' && (
                <EuiFormRow label="Cron expression" helpText="Standard 5-field cron: minute hour day-of-month month day-of-week">
                  <EuiFieldText
                    value={cronExpr}
                    onChange={e => setCronExpr(e.target.value)}
                    placeholder="0 2 1 * *"
                  />
                </EuiFormRow>
              )}

              <EuiSpacer size="m" />

              <EuiPanel color="subdued" paddingSize="s">
                <EuiText size="s">
                  <strong>Schedule preview:</strong> {getPreview()}
                  {scheduleMode !== 'cron' && scheduleMode !== 'interval' && (
                    <> &mdash; <EuiCode>{buildCron(scheduleMode, { dayOfMonth, dayOfWeek, hour, minute }) ?? ''}</EuiCode></>
                  )}
                </EuiText>
              </EuiPanel>

              <EuiSpacer size="m" />

              <EuiSwitch
                label="Configure action parameters"
                checked={showParams}
                onChange={e => setShowParams(e.target.checked)}
              />

              {showParams && jobAction === 'rotate' && (
                <>
                  <EuiSpacer size="s" />
                  <EuiFormRow label="Keep (number of recent rotations to retain)">
                    <EuiFieldNumber value={keepParam} onChange={e => setKeepParam(Number(e.target.value))} min={1} max={100} />
                  </EuiFormRow>
                </>
              )}
            </EuiForm>
          </EuiModalBody>
          <EuiModalFooter>
            <EuiButtonEmpty onClick={closeModal}>Cancel</EuiButtonEmpty>
            <EuiButton fill onClick={handleSubmit} isLoading={submitting}>
              {modalMode === 'edit' ? 'Save Changes' : 'Add Job'}
            </EuiButton>
          </EuiModalFooter>
        </EuiModal>
      )}

      {/* Delete confirmation */}
      {deleteTarget && (
        <EuiConfirmModal
          title={`Remove "${deleteTarget}"?`}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={handleDelete}
          cancelButtonText="Cancel"
          confirmButtonText="Remove"
          buttonColor="danger"
        >
          <EuiText size="s">
            <p>This will remove the scheduled job. It can be re-added later.</p>
          </EuiText>
        </EuiConfirmModal>
      )}

      <EuiGlobalToastList
        toasts={toasts}
        dismissToast={(t) => setToasts(prev => prev.filter(x => x.id !== t.id))}
        toastLifeTimeMs={6000}
      />
    </>
  );
}
