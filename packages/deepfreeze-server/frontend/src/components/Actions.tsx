import { useState, useCallback, useEffect } from 'react';
import {
  EuiFlexGroup,
  EuiFlexItem,
  EuiPanel,
  EuiTitle,
  EuiText,
  EuiButton,
  EuiSpacer,
  EuiConfirmModal,
  EuiForm,
  EuiFormRow,
  EuiFieldNumber,
  EuiDatePicker,
  EuiSwitch,
  EuiGlobalToastList,
  EuiIcon,
  EuiSuperSelect,
  EuiBadge,
} from '@elastic/eui';
import moment, { type Moment } from 'moment';
import { api, type CommandResult } from '../api/client';

interface ActionCard {
  id: string;
  title: string;
  description: string;
  icon: string;
  color: 'primary' | 'success' | 'warning' | 'danger' | 'accent';
  // cta: card button label (trailing ellipsis signals it opens an options dialog).
  // confirm: the committed action, used for the dialog's confirm button and title.
  cta: string;
  confirm: string;
}

const actionCards: ActionCard[] = [
  {
    id: 'thaw',
    title: 'Thaw',
    description: 'Thaw data for a given date range by requesting it from storage and mounting it when ready.',
    icon: 'temperature',
    color: 'warning',
    cta: 'Thaw Data…',
    confirm: 'Thaw data',
  },
  {
    id: 'refreeze',
    title: 'Refreeze',
    description: 'Refreeze thawed indices, unmount snapshots, and mark thaw requests as complete.',
    icon: 'snowflake',
    color: 'danger',
    cta: 'Refreeze Indices…',
    confirm: 'Refreeze indices',
  },
  {
    id: 'rotate',
    title: 'Rotate',
    description: 'Rotate snapshot repositories, set a new ILM policy for the new repo, and send the oldest to long-term storage.',
    icon: 'sortRight',
    color: 'primary',
    cta: 'Rotate Now…',
    confirm: 'Rotate now',
  },
  {
    id: 'cleanup',
    title: 'Cleanup',
    description: 'Clean up refrozen indices and temporary thaw artifacts that are past retention.',
    icon: 'broom',
    color: 'accent',
    cta: 'Clean Up…',
    confirm: 'Clean up',
  },
  {
    id: 'repair',
    title: 'Fix / Repair',
    description: 'Detect and repair inconsistencies in snapshot registrations and state tracking.',
    icon: 'wrench',
    color: 'success',
    cta: 'Detect & Repair…',
    confirm: 'Detect & repair',
  },
];

interface Toast {
  id: string;
  title: string;
  color: 'success' | 'danger' | 'warning';
  text?: string;
}

interface ThawRequest {
  request_id: string;
  status: string;
  start_date?: string;
  end_date?: string;
  created?: string;
  repos?: string[];
}

const STATUS_COLORS: Record<string, string> = {
  completed: 'success',
  in_progress: 'warning',
  thawing: 'warning',
  failed: 'danger',
  refrozen: 'default',
};

export default function Actions() {
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [executing, setExecuting] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  // Thaw form state
  const [thawStartDate, setThawStartDate] = useState<Moment | null>(moment().subtract(30, 'days'));
  const [thawEndDate, setThawEndDate] = useState<Moment | null>(moment());
  const [thawDuration, setThawDuration] = useState<number>(30);
  const [dryRun, setDryRun] = useState(false);

  // Rotate form state
  const [rotateKeep, setRotateKeep] = useState<number>(6);

  // Refreeze form state
  const [thawRequests, setThawRequests] = useState<ThawRequest[]>([]);
  const [selectedRequestId, setSelectedRequestId] = useState<string>('__all__');
  const [loadingRequests, setLoadingRequests] = useState(false);

  const addToast = useCallback((title: string, color: 'success' | 'danger' | 'warning', text?: string) => {
    const id = String(Date.now());
    setToasts((prev) => [...prev, { id, title, color, text }]);
  }, []);

  const removeToast = useCallback((removedToast: { id: string }) => {
    setToasts((prev) => prev.filter((t) => t.id !== removedToast.id));
  }, []);

  // Fetch thaw requests when refreeze modal opens
  useEffect(() => {
    if (activeAction === 'refreeze') {
      setLoadingRequests(true);
      api.getThawRequests()
        .then((data) => {
          const requests = (data.thaw_requests || []).map((r: Record<string, unknown>) => r as unknown as ThawRequest);
          // Only show requests that can be refrozen (completed or in_progress)
          const refreezeble = requests.filter(
            (r) => r.status === 'completed' || r.status === 'in_progress'
          );
          setThawRequests(refreezeble);
        })
        .catch(() => setThawRequests([]))
        .finally(() => setLoadingRequests(false));
    }
  }, [activeAction]);

  const handleExecute = async () => {
    if (!activeAction) return;
    setExecuting(true);

    try {
      let result: CommandResult;

      switch (activeAction) {
        case 'rotate':
          result = await api.rotate({ keep: rotateKeep, dry_run: dryRun });
          break;
        case 'thaw':
          result = await api.thawCreate({
            start_date: thawStartDate?.format('YYYY-MM-DDTHH:mm:ss') || '',
            end_date: thawEndDate?.format('YYYY-MM-DDTHH:mm:ss') || '',
            duration: thawDuration,
            dry_run: dryRun,
          });
          break;
        case 'cleanup':
          result = await api.cleanup({ dry_run: dryRun });
          break;
        case 'repair':
          result = await api.repair({ dry_run: dryRun });
          break;
        case 'refreeze':
          result = await api.refreeze({
            request_id: selectedRequestId === '__all__' ? undefined : selectedRequestId,
            dry_run: dryRun,
          });
          break;
        default:
          throw new Error(`Unknown action: ${activeAction}`);
      }

      if (result.success) {
        addToast(
          `${result.action} ${dryRun ? '(dry run) ' : ''}${activeAction === 'thaw' ? 'submitted' : 'completed'}`,
          'success',
          result.summary || `Action ${activeAction === 'thaw' ? 'submitted' : 'completed'} successfully.`,
        );
      } else {
        addToast(
          `${result.action} failed`,
          'danger',
          result.summary || 'Action failed. Check errors for details.',
        );
      }
    } catch (err) {
      addToast(
        `Error executing ${activeAction}`,
        'danger',
        err instanceof Error ? err.message : 'Unknown error',
      );
    } finally {
      setExecuting(false);
      setActiveAction(null);
      setSelectedRequestId('__all__');
    }
  };

  const card = activeAction ? actionCards.find((c) => c.id === activeAction) : null;

  // Build refreeze selector options
  const refreezeOptions = [
    {
      value: '__all__',
      inputDisplay: 'All completed thaw requests',
      dropdownDisplay: (
        <>
          <strong>All completed thaw requests</strong>
          <EuiText size="xs" color="subdued"><p>Refreeze every completed thaw request at once</p></EuiText>
        </>
      ),
    },
    ...thawRequests.map((req) => {
      const dates = req.start_date && req.end_date
        ? `${req.start_date.substring(0, 16)} \u2014 ${req.end_date.substring(0, 16)}`
        : 'No date range';
      const repoCount = req.repos?.length || 0;
      return {
        value: req.request_id,
        inputDisplay: `${req.request_id.substring(0, 8)}... (${dates})`,
        dropdownDisplay: (
          <>
            <strong>{req.request_id.substring(0, 8)}...</strong>
            {' '}
            <EuiBadge color={STATUS_COLORS[req.status] || 'default'}>{req.status}</EuiBadge>
            <EuiText size="xs" color="subdued">
              <p>
                {dates}
                {repoCount > 0 && ` \u00b7 ${repoCount} repo${repoCount !== 1 ? 's' : ''}`}
                {req.created && ` \u00b7 Created ${req.created.substring(0, 16)}`}
              </p>
            </EuiText>
          </>
        ),
      };
    }),
  ];

  return (
    <>
      <EuiTitle size="l">
        <h2>Actions</h2>
      </EuiTitle>

      <EuiSpacer size="l" />

      <EuiFlexGroup gutterSize="l" wrap>
        {actionCards.map((ac) => (
          <EuiFlexItem key={ac.id} style={{ minWidth: 280 }}>
            <EuiPanel hasBorder paddingSize="l" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              <EuiFlexGroup alignItems="center" gutterSize="m" responsive={false}>
                <EuiFlexItem grow={false}>
                  <EuiIcon type={ac.icon} size="xl" color={ac.color} />
                </EuiFlexItem>
                <EuiFlexItem>
                  <EuiTitle size="s">
                    <h3>{ac.title}</h3>
                  </EuiTitle>
                </EuiFlexItem>
              </EuiFlexGroup>
              <EuiSpacer size="s" />
              <EuiText size="s" color="subdued">
                <p>{ac.description}</p>
              </EuiText>
              <div style={{ marginTop: 'auto', paddingTop: 16 }}>
                <EuiButton
                  color={ac.color}
                  onClick={() => setActiveAction(ac.id)}
                  fullWidth
                >
                  {ac.cta}
                </EuiButton>
              </div>
            </EuiPanel>
          </EuiFlexItem>
        ))}
      </EuiFlexGroup>

      {/* Confirm Modal */}
      {activeAction && card && (
        <EuiConfirmModal
          title={`${card.confirm}?`}
          onCancel={() => { setActiveAction(null); setSelectedRequestId('__all__'); }}
          onConfirm={handleExecute}
          cancelButtonText="Cancel"
          confirmButtonText={executing ? 'Working…' : card.confirm}
          buttonColor={card.color}
          isLoading={executing}
        >
          <EuiText size="s">
            <p>{card.description}</p>
          </EuiText>

          <EuiSpacer size="m" />

          {activeAction === 'thaw' && (
            <EuiForm>
              <EuiFormRow label="Start Date">
                <EuiDatePicker
                  selected={thawStartDate}
                  onChange={(date) => setThawStartDate(date)}
                  showTimeSelect
                  dateFormat="YYYY-MM-DD HH:mm"
                  timeFormat="HH:mm"
                />
              </EuiFormRow>
              <EuiFormRow label="End Date">
                <EuiDatePicker
                  selected={thawEndDate}
                  onChange={(date) => setThawEndDate(date)}
                  showTimeSelect
                  dateFormat="YYYY-MM-DD HH:mm"
                  timeFormat="HH:mm"
                />
              </EuiFormRow>
              <EuiFormRow label="Duration (days)">
                <EuiFieldNumber
                  value={thawDuration}
                  onChange={(e) => setThawDuration(Number(e.target.value))}
                  min={1}
                  max={365}
                />
              </EuiFormRow>
            </EuiForm>
          )}

          {activeAction === 'rotate' && (
            <EuiForm>
              <EuiFormRow
                label="Keep"
                helpText="Number of repositories to keep mounted after rotation"
              >
                <EuiFieldNumber
                  value={rotateKeep}
                  onChange={(e) => setRotateKeep(Number(e.target.value))}
                  min={1}
                  max={100}
                />
              </EuiFormRow>
            </EuiForm>
          )}

          {activeAction === 'refreeze' && (
            <EuiForm>
              <EuiFormRow
                label="Thaw request to refreeze"
                helpText={
                  thawRequests.length === 0 && !loadingRequests
                    ? 'No completed thaw requests found'
                    : undefined
                }
              >
                <EuiSuperSelect
                  options={refreezeOptions}
                  valueOfSelected={selectedRequestId}
                  onChange={(value) => setSelectedRequestId(value)}
                  isLoading={loadingRequests}
                  fullWidth
                />
              </EuiFormRow>
            </EuiForm>
          )}

          <EuiSpacer size="m" />

          <EuiSwitch
            label="Dry run (preview only, no changes)"
            checked={dryRun}
            onChange={(e) => setDryRun(e.target.checked)}
          />
        </EuiConfirmModal>
      )}

      <EuiGlobalToastList
        toasts={toasts}
        dismissToast={removeToast as any}
        toastLifeTimeMs={8000}
      />
    </>
  );
}
