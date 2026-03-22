import { useState, useCallback } from 'react';
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
  type EuiToastProps,
} from '@elastic/eui';
import moment, { type Moment } from 'moment';
import { api, type CommandResult } from '../api/client';

interface ActionCard {
  id: string;
  title: string;
  description: string;
  icon: string;
  color: 'primary' | 'success' | 'warning' | 'danger' | 'accent';
}

const actionCards: ActionCard[] = [
  {
    id: 'rotate',
    title: 'Rotate',
    description: 'Rotate indices into snapshot repositories and freeze them according to the configured schedule.',
    icon: 'sortRight',
    color: 'primary',
  },
  {
    id: 'thaw',
    title: 'Thaw',
    description: 'Create a thaw request to restore frozen indices for a specified date range.',
    icon: 'temperature',
    color: 'warning',
  },
  {
    id: 'cleanup',
    title: 'Cleanup',
    description: 'Clean up refrozen indices and temporary thaw artifacts that are past retention.',
    icon: 'broom',
    color: 'accent',
  },
  {
    id: 'repair',
    title: 'Fix / Repair',
    description: 'Detect and repair inconsistencies in snapshot registrations and state tracking.',
    icon: 'wrench',
    color: 'success',
  },
  {
    id: 'refreeze',
    title: 'Refreeze',
    description: 'Refreeze thawed indices, unmount snapshots, and mark thaw requests as complete.',
    icon: 'snowflake',
    color: 'danger',
  },
];

type Toast = EuiToastProps & { id: string };

export default function Actions() {
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [executing, setExecuting] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  // Thaw form state
  const [thawStartDate, setThawStartDate] = useState<Moment | null>(moment().subtract(30, 'days'));
  const [thawEndDate, setThawEndDate] = useState<Moment | null>(moment());
  const [thawDuration, setThawDuration] = useState<number>(72);
  const [dryRun, setDryRun] = useState(false);

  const addToast = useCallback((title: string, color: 'success' | 'danger' | 'warning', text?: string) => {
    const id = String(Date.now());
    setToasts((prev) => [...prev, { id, title, color, text }]);
  }, []);

  const removeToast = useCallback((removedToast: { id: string }) => {
    setToasts((prev) => prev.filter((t) => t.id !== removedToast.id));
  }, []);

  const handleExecute = async () => {
    if (!activeAction) return;
    setExecuting(true);

    try {
      let result: CommandResult;

      switch (activeAction) {
        case 'rotate':
          result = await api.rotate({ dry_run: dryRun });
          break;
        case 'thaw':
          result = await api.thawCreate({
            start_date: thawStartDate?.format('YYYY-MM-DD') || '',
            end_date: thawEndDate?.format('YYYY-MM-DD') || '',
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
          result = await api.refreeze({ dry_run: dryRun });
          break;
        default:
          throw new Error(`Unknown action: ${activeAction}`);
      }

      if (result.success) {
        addToast(
          `${result.action} ${dryRun ? '(dry run) ' : ''}completed`,
          'success',
          result.summary || 'Action completed successfully.',
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
    }
  };

  const card = activeAction ? actionCards.find((c) => c.id === activeAction) : null;

  return (
    <>
      <EuiTitle size="l">
        <h2>Actions</h2>
      </EuiTitle>

      <EuiSpacer size="l" />

      <EuiFlexGroup gutterSize="l" wrap>
        {actionCards.map((ac) => (
          <EuiFlexItem key={ac.id} style={{ minWidth: 280 }}>
            <EuiPanel hasBorder paddingSize="l">
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
              <EuiSpacer size="m" />
              <EuiButton
                color={ac.color}
                onClick={() => setActiveAction(ac.id)}
                fullWidth
              >
                Run {ac.title}
              </EuiButton>
            </EuiPanel>
          </EuiFlexItem>
        ))}
      </EuiFlexGroup>

      {/* Confirm Modal */}
      {activeAction && card && (
        <EuiConfirmModal
          title={`Run ${card.title}?`}
          onCancel={() => setActiveAction(null)}
          onConfirm={handleExecute}
          cancelButtonText="Cancel"
          confirmButtonText={executing ? 'Executing...' : `Run ${card.title}`}
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
                  dateFormat="YYYY-MM-DD"
                />
              </EuiFormRow>
              <EuiFormRow label="End Date">
                <EuiDatePicker
                  selected={thawEndDate}
                  onChange={(date) => setThawEndDate(date)}
                  dateFormat="YYYY-MM-DD"
                />
              </EuiFormRow>
              <EuiFormRow label="Duration (hours)">
                <EuiFieldNumber
                  value={thawDuration}
                  onChange={(e) => setThawDuration(Number(e.target.value))}
                  min={1}
                  max={720}
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
        dismissToast={removeToast}
        toastLifeTimeMs={8000}
      />
    </>
  );
}
