import React, { useCallback, useMemo, useState } from 'react';
import {
  EuiBadge,
  EuiButton,
  EuiButtonEmpty,
  EuiCallOut,
  EuiDescriptionList,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFlyout,
  EuiFlyoutBody,
  EuiFlyoutHeader,
  EuiInMemoryTable,
  EuiProgress,
  EuiSpacer,
  EuiText,
  EuiTitle,
  type EuiBasicTableColumn,
  type EuiSearchBarProps,
} from '@elastic/eui';
import type { CoreStart } from '@kbn/core/public';

import { useStatus } from '../hooks/use_status';
import { postThawCheck, useThawProgress } from '../hooks/use_thaw_progress';
import { RefreshControl } from '../components/refresh_control';
import { PageLoading, PageError } from '../components/page_states';
import { RefreezeModal } from '../components/refreeze_modal';
import { ThawModal } from '../components/thaw_modal';
import { formatStoredDatetime, formatTimestamp } from '../utils/format';
import type { StatusResult } from '../../server/actions/status';
import type { ThawProgressResult } from '../../server/actions/thaw';

type ThawReq = StatusResult['thaw_requests'][number];

interface ThawRequestsPageProps {
  http: CoreStart['http'];
  notifications: CoreStart['notifications'];
}

function statusColor(
  s: string
): 'success' | 'warning' | 'danger' | 'primary' | 'default' {
  switch (s) {
    case 'completed':
      return 'success';
    case 'in_progress':
      return 'warning';
    case 'failed':
      return 'danger';
    case 'refrozen':
      return 'primary';
    default:
      return 'default';
  }
}

/**
 * Live restore progress for a single thaw request, rendered inside the
 * row flyout. Polls /progress every 30s while the request is
 * in_progress; the "Check now" button fires /check, which mounts the
 * repos and flips status to completed when every object is warm.
 */
function ThawProgressSection({
  http,
  notifications,
  requestId,
  status,
  onStatusChange,
}: {
  http: CoreStart['http'];
  notifications: CoreStart['notifications'];
  requestId: string;
  status: ThawReq['status'];
  /** Called when /check flips the status so the parent can refetch. */
  onStatusChange: () => void;
}) {
  const inFlight = status === 'in_progress';
  const { progress, loading, error, refresh } = useThawProgress(
    http,
    requestId,
    inFlight
  );
  const [checking, setChecking] = useState(false);
  const [latestStatus, setLatestStatus] = useState<ThawProgressResult['status']>(status);

  const doCheck = useCallback(async () => {
    setChecking(true);
    try {
      const result = await postThawCheck(http, requestId);
      setLatestStatus(result.status);
      if (result.status === 'completed') {
        notifications.toasts.addSuccess({
          title: `Thaw completed (${requestId.slice(0, 8)})`,
          text: 'All objects restored; repositories mounted.',
        });
        onStatusChange();
      } else if (result.status === 'failed') {
        notifications.toasts.addDanger({
          title: `Thaw failed (${requestId.slice(0, 8)})`,
          text:
            result.errors.map((e) => e.message).join('; ') ||
            'Mount step failed.',
        });
        onStatusChange();
      } else {
        notifications.toasts.addInfo({
          title: 'Still restoring',
          text:
            'Restore is in progress; check back in a few minutes (Glacier Standard is 3–5h).',
        });
        refresh();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      notifications.toasts.addDanger({ title: 'Check failed', text: msg });
    } finally {
      setChecking(false);
    }
  }, [http, notifications, requestId, refresh, onStatusChange]);

  if (!inFlight && latestStatus !== 'in_progress') {
    return null;
  }

  return (
    <>
      <EuiSpacer size="l" />
      <EuiTitle size="xs">
        <h3>Restore progress</h3>
      </EuiTitle>
      <EuiSpacer size="s" />

      {error && (
        <EuiCallOut color="danger" iconType="alert" title="Could not fetch progress" size="s">
          <p>{error}</p>
        </EuiCallOut>
      )}

      {progress && progress.repos.length > 0 && (
        <>
          {progress.repos.map((p) => (
            <div key={p.repo} style={{ marginBottom: 12 }}>
              <EuiText size="s">
                <strong>{p.repo}</strong> — {p.restored}/{p.total} restored
                {p.in_progress > 0 ? `, ${p.in_progress} in progress` : ''}
                {p.not_restored > 0 ? `, ${p.not_restored} not yet started` : ''}
              </EuiText>
              <EuiProgress
                value={p.total > 0 ? p.restored : 0}
                max={p.total > 0 ? p.total : 1}
                color={p.complete ? 'success' : 'primary'}
                size="s"
              />
            </div>
          ))}
        </>
      )}

      {progress && progress.repos.length === 0 && (
        <EuiText size="s" color="subdued">
          <p>Waiting for first progress sample…</p>
        </EuiText>
      )}

      <EuiSpacer size="s" />
      <EuiFlexGroup gutterSize="s" alignItems="center">
        <EuiFlexItem grow={false}>
          <EuiButton
            size="s"
            iconType="refresh"
            onClick={doCheck}
            isLoading={checking || loading}
          >
            Check now
          </EuiButton>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiText size="xs" color="subdued">
            {progress?.checked_at
              ? `Last checked ${formatTimestamp(progress.checked_at)}`
              : 'Polling every 30s'}
          </EuiText>
        </EuiFlexItem>
      </EuiFlexGroup>
    </>
  );
}

export function ThawRequestsPage({ http, notifications }: ThawRequestsPageProps) {
  const { status, loading, error, refresh } = useStatus(http);
  const [flyoutItem, setFlyoutItem] = useState<ThawReq | null>(null);
  const [refreezeTarget, setRefreezeTarget] = useState<ThawReq | null>(null);
  const [thawOpen, setThawOpen] = useState(false);
  // Per-row "checking now" state — keyed by request_id so multiple
  // in_progress rows don't block each other.
  const [checkingId, setCheckingId] = useState<string | null>(null);

  const handleCheckNow = useCallback(
    async (item: ThawReq) => {
      const id = item.request_id;
      if (!id) return;
      setCheckingId(id);
      try {
        const result = await postThawCheck(http, id);
        if (result.status === 'completed') {
          notifications.toasts.addSuccess({
            title: `Thaw completed (${id.slice(0, 8)})`,
            text: 'All objects restored; repositories mounted.',
          });
        } else if (result.status === 'failed') {
          notifications.toasts.addDanger({
            title: `Thaw failed (${id.slice(0, 8)})`,
            text:
              result.errors.map((e) => e.message).join('; ') || 'Mount step failed.',
          });
        } else {
          notifications.toasts.addInfo({
            title: `Still restoring (${id.slice(0, 8)})`,
            text: 'Restore is in progress; the poller will keep checking every 60s.',
          });
        }
        refresh();
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        notifications.toasts.addDanger({ title: 'Check failed', text: msg });
      } finally {
        setCheckingId(null);
      }
    },
    [http, notifications, refresh]
  );

  const requests = useMemo<ThawReq[]>(
    () => (status ? status.thaw_requests : []),
    [status]
  );

  const statusOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const r of requests) {
      if (r.status) seen.add(r.status);
    }
    return [...seen].sort().map((value) => ({ value, name: value }));
  }, [requests]);

  if (loading && !status) return <PageLoading />;
  if (error && !status) return <PageError message={error} onRetry={refresh} />;

  const columns: Array<EuiBasicTableColumn<ThawReq>> = [
    {
      field: 'request_id',
      name: 'Request ID',
      sortable: true,
      render: (id: string) => (
        <EuiText size="s">
          <code>{id ? id.substring(0, 8) : '--'}</code>
        </EuiText>
      ),
    },
    {
      field: 'status',
      name: 'Status',
      sortable: true,
      render: (s: string) => (
        <EuiBadge color={statusColor(s || 'unknown')}>{s || 'unknown'}</EuiBadge>
      ),
    },
    {
      field: 'start_date',
      name: 'Date range (UTC)',
      render: (_: unknown, item: ThawReq) => {
        const start = formatStoredDatetime(item.start_date);
        const end = formatStoredDatetime(item.end_date);
        if (!start && !end) return '--';
        return (
          <EuiText size="s">
            {start || '?'} &rarr; {end || '?'}
          </EuiText>
        );
      },
    },
    {
      field: 'repos',
      name: 'Repos',
      render: (repos: unknown) => (Array.isArray(repos) ? repos.length : '--'),
    },
    {
      field: 'created_at',
      name: 'Created',
      sortable: true,
      render: (ts: string) => (ts ? formatTimestamp(ts) : '--'),
    },
    {
      name: 'Actions',
      width: '120px',
      actions: [
        {
          name: 'Check now',
          description:
            'Force an immediate restore-completion check (the background poller already runs every 60s).',
          icon: 'refresh',
          type: 'icon',
          // Only enabled for in_progress requests AND not while a check
          // is in flight against this same row.
          enabled: (item: ThawReq) =>
            item.status === 'in_progress' && checkingId !== item.request_id,
          available: (item: ThawReq) => item.status === 'in_progress',
          onClick: handleCheckNow,
          'data-test-subj': 'thaw-check-now',
        },
      ],
    },
  ];

  const search: EuiSearchBarProps = {
    box: { incremental: true, schema: true, placeholder: 'Search thaw requests…' },
    toolsRight: [
      <EuiButton
        key="new-thaw"
        iconType="plusInCircle"
        fill
        onClick={() => setThawOpen(true)}
      >
        Initiate thaw
      </EuiButton>,
      <RefreshControl key="refresh" onRefresh={refresh} loading={loading} />,
    ],
    filters: [
      {
        type: 'field_value_selection',
        field: 'status',
        name: 'Status',
        multiSelect: 'or',
        options: statusOptions,
      },
    ],
  };

  return (
    <>
      <EuiFlexGroup justifyContent="spaceBetween" alignItems="center">
        <EuiFlexItem grow={false}>
          <EuiTitle size="m">
            <h2>Thaw requests</h2>
          </EuiTitle>
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiSpacer size="m" />

      <EuiInMemoryTable
        items={requests}
        columns={columns}
        compressed
        responsiveBreakpoint={false}
        search={search}
        sorting={{ sort: { field: 'created_at', direction: 'desc' } }}
        pagination={{ pageSizeOptions: [10, 25, 50], initialPageSize: 25 }}
        loading={loading}
        rowProps={(item: ThawReq) => ({
          onClick: () => setFlyoutItem(item),
          style: { cursor: 'pointer' },
        })}
        noItemsMessage={
          requests.length === 0 ? (
            <EuiFlexGroup direction="column" alignItems="center" gutterSize="s">
              <EuiFlexItem>
                <EuiText size="s">No thaw requests yet.</EuiText>
              </EuiFlexItem>
              <EuiFlexItem>
                <EuiButtonEmpty iconType="plusInCircle" onClick={() => setThawOpen(true)}>
                  Initiate a thaw
                </EuiButtonEmpty>
              </EuiFlexItem>
            </EuiFlexGroup>
          ) : (
            'No thaw requests match the current filters.'
          )
        }
      />

      {flyoutItem && (
        <EuiFlyout onClose={() => setFlyoutItem(null)} size="m" ownFocus>
          <EuiFlyoutHeader hasBorder>
            <EuiTitle size="m">
              <h2>
                Thaw request{' '}
                <code>{String(flyoutItem.request_id || '').substring(0, 8)}</code>
              </h2>
            </EuiTitle>
          </EuiFlyoutHeader>
          <EuiFlyoutBody>
            <EuiDescriptionList
              type="column"
              compressed
              listItems={[
                { title: 'Request ID', description: String(flyoutItem.request_id || '--') },
                { title: 'Status', description: String(flyoutItem.status || '--') },
                {
                  title: 'Created at',
                  description: formatTimestamp(flyoutItem.created_at) || '--',
                },
                {
                  title: 'Date range (UTC)',
                  description: `${formatStoredDatetime(flyoutItem.start_date) || '?'} → ${
                    formatStoredDatetime(flyoutItem.end_date) || '?'
                  }`,
                },
              ]}
            />

            {Array.isArray(flyoutItem.repos) && flyoutItem.repos.length > 0 && (
              <>
                <EuiSpacer size="l" />
                <EuiTitle size="xs">
                  <h3>Repositories ({flyoutItem.repos.length})</h3>
                </EuiTitle>
                <EuiSpacer size="s" />
                {flyoutItem.repos.map((name, i) => (
                  <div key={i} style={{ marginBottom: 8 }}>
                    <EuiBadge color="hollow">{String(name)}</EuiBadge>
                  </div>
                ))}
              </>
            )}

            <ThawProgressSection
              http={http}
              notifications={notifications}
              requestId={String(flyoutItem.request_id || '')}
              status={flyoutItem.status as ThawReq['status']}
              onStatusChange={() => {
                refresh();
                setFlyoutItem(null);
              }}
            />

            {flyoutItem.status === 'completed' && (
              <>
                <EuiSpacer size="l" />
                <EuiButton
                  color="danger"
                  iconType="snowflake"
                  onClick={() => {
                    setRefreezeTarget(flyoutItem);
                    setFlyoutItem(null);
                  }}
                  fullWidth
                >
                  Refreeze this request
                </EuiButton>
              </>
            )}
          </EuiFlyoutBody>
        </EuiFlyout>
      )}

      {refreezeTarget && (
        <RefreezeModal
          http={http}
          notifications={notifications}
          request_id={refreezeTarget.request_id}
          repo_names={refreezeTarget.repos}
          onClose={() => setRefreezeTarget(null)}
          onComplete={refresh}
        />
      )}

      {thawOpen && (
        <ThawModal
          http={http}
          notifications={notifications}
          onClose={() => setThawOpen(false)}
          onComplete={refresh}
        />
      )}
    </>
  );
}
