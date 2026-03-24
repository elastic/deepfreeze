import { useState, useMemo, useCallback, useEffect } from 'react';
import { trimDate } from '../api/util';
import {
  EuiBasicTable,
  EuiFlyout,
  EuiFlyoutBody,
  EuiFlyoutHeader,
  EuiTitle,
  EuiBadge,
  EuiSpacer,
  EuiDescriptionList,
  EuiFlexGroup,
  EuiFlexItem,
  EuiButton,
  EuiLoadingSpinner,
  EuiCallOut,
  EuiText,
  EuiProgress,
  type CriteriaWithPagination,
  type EuiBasicTableColumn,
} from '@elastic/eui';
import { useStatus } from '../hooks/useStatus';
import { api, type RestoreProgress } from '../api/client';
import RefreshControl from '../components/RefreshControl';

type ThawRequest = Record<string, unknown>;

function statusColor(s: string): string {
  switch (s) {
    case 'completed':
      return 'success';
    case 'in_progress':
    case 'pending':
      return 'warning';
    case 'failed':
      return 'danger';
    case 'refrozen':
      return 'primary';
    default:
      return 'default';
  }
}

function formatElapsed(createdAt: string): string {
  try {
    const created = new Date(createdAt);
    const now = new Date();
    const totalSec = Math.max(0, Math.floor((now.getTime() - created.getTime()) / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  } catch {
    return '';
  }
}

function ThawFlyoutContent({ item }: { item: ThawRequest }) {
  const [elapsed, setElapsed] = useState('');
  const createdAt = String(item.created_at || '');

  useEffect(() => {
    if (!createdAt) return;
    setElapsed(formatElapsed(createdAt));
    const timer = setInterval(() => setElapsed(formatElapsed(createdAt)), 1000);
    return () => clearInterval(timer);
  }, [createdAt]);

  const listItems = [
    { title: 'Request ID', description: String(item.request_id || item.id || '--') },
    { title: 'Status', description: String(item.status || '--') },
    { title: 'Created At', description: createdAt ? `${trimDate(createdAt)}  (${elapsed} ago)` : '--' },
    { title: 'Date Range', description: `${trimDate(item.start_date) || '?'} \u2192 ${trimDate(item.end_date) || '?'}` },
  ];

  return (
    <EuiDescriptionList type="column" compressed listItems={listItems} />
  );
}

export default function ThawRequests() {
  const { status, loading, error, refresh } = useStatus();
  const [flyoutItem, setFlyoutItem] = useState<ThawRequest | null>(null);
  const [restoreProgress, setRestoreProgress] = useState<RestoreProgress[] | null>(null);
  const [progressLoading, setProgressLoading] = useState(false);

  const openFlyout = useCallback((item: ThawRequest) => {
    setFlyoutItem(item);
    setRestoreProgress(null);
    // Load restore progress for in_progress requests
    if (item.status === 'in_progress') {
      const reqId = String(item.request_id || item.id || '');
      if (reqId) {
        setProgressLoading(true);
        api.getRestoreProgress(reqId)
          .then((data) => setRestoreProgress(data.repos))
          .catch(() => setRestoreProgress(null))
          .finally(() => setProgressLoading(false));
      }
    }
  }, []);
  const [sortField, setSortField] = useState<string>('created_at');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(20);

  const requests: ThawRequest[] = useMemo(() => {
    if (!status) return [];
    return status.thaw_requests || [];
  }, [status]);

  const sorted = useMemo(() => {
    const copy = [...requests];
    copy.sort((a, b) => {
      const aVal = String(a[sortField] ?? '');
      const bVal = String(b[sortField] ?? '');
      return sortDirection === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    });
    return copy;
  }, [requests, sortField, sortDirection]);

  const paged = sorted.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);

  const columns: EuiBasicTableColumn<ThawRequest>[] = [
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
        <EuiBadge color={statusColor(s || 'unknown')}>
          {s || 'unknown'}
        </EuiBadge>
      ),
    },
    {
      field: 'date_range',
      name: 'Date Range',
      render: (_: unknown, item: ThawRequest) => {
        const start = trimDate(item.start_date);
        const end = trimDate(item.end_date);
        if (!start && !end) return '--';
        return (
          <EuiText size="s">
            {start || '?'} &rarr; {end || '?'}
          </EuiText>
        );
      },
    },
    {
      field: 'repositories',
      name: 'Repos',
      render: (repos: unknown) => {
        if (Array.isArray(repos)) return repos.length;
        return '--';
      },
    },
    {
      field: 'created_at',
      name: 'Created',
      sortable: true,
      render: (ts: string) => {
        if (!ts) return '--';
        return trimDate(ts);
      },
    },
  ];

  const onTableChange = ({ page, sort }: CriteriaWithPagination<ThawRequest>) => {
    if (page) {
      setPageIndex(page.index);
      setPageSize(page.size);
    }
    if (sort) {
      setSortField(sort.field as string);
      setSortDirection(sort.direction);
    }
  };

  if (loading && !status) {
    return (
      <EuiFlexGroup justifyContent="center" alignItems="center" style={{ minHeight: 300 }}>
        <EuiFlexItem grow={false}>
          <EuiLoadingSpinner size="xl" />
        </EuiFlexItem>
      </EuiFlexGroup>
    );
  }

  if (error && !status) {
    return (
      <EuiCallOut title="Error loading thaw requests" color="danger" iconType="alert">
        <p>{error}</p>
        <EuiButton color="danger" onClick={() => refresh(true)}>
          Retry
        </EuiButton>
      </EuiCallOut>
    );
  }

  return (
    <>
      <EuiFlexGroup justifyContent="spaceBetween" alignItems="center">
        <EuiFlexItem grow={false}>
          <EuiTitle size="l">
            <h2>Thaw Requests</h2>
          </EuiTitle>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <RefreshControl onRefresh={() => refresh(true)} loading={loading} />
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiSpacer size="m" />

      <EuiBasicTable
        items={paged}
        columns={columns}
        sorting={{
          sort: { field: sortField, direction: sortDirection },
        }}
        pagination={{
          pageIndex,
          pageSize,
          totalItemCount: sorted.length,
          pageSizeOptions: [10, 20, 50],
        }}
        onChange={onTableChange}
        rowProps={(item: ThawRequest) => ({
          onClick: () => openFlyout(item),
          style: { cursor: 'pointer' },
        })}
        noItemsMessage="No thaw requests found"
      />

      {flyoutItem && (
        <EuiFlyout onClose={() => setFlyoutItem(null)} size="m" ownFocus>
          <EuiFlyoutHeader hasBorder>
            <EuiTitle size="m">
              <h2>
                Thaw Request{' '}
                <code>{String(flyoutItem.request_id || '').substring(0, 8)}</code>
              </h2>
            </EuiTitle>
          </EuiFlyoutHeader>
          <EuiFlyoutBody>
            <ThawFlyoutContent item={flyoutItem} />

            {Array.isArray(flyoutItem.repositories) && flyoutItem.repositories.length > 0 && (
              <>
                <EuiSpacer size="l" />
                <EuiTitle size="xs">
                  <h3>Repositories ({(flyoutItem.repositories as unknown[]).length})</h3>
                </EuiTitle>
                <EuiSpacer size="s" />
                {(flyoutItem.repositories as Record<string, unknown>[]).map((repo, i) => (
                  <div key={i} style={{ marginBottom: 8 }}>
                    <EuiBadge color="hollow">
                      {String(repo.name || repo.repository || repo)}
                    </EuiBadge>
                  </div>
                ))}
              </>
            )}

            {flyoutItem.status === 'in_progress' && (
              <>
                <EuiSpacer size="l" />
                <EuiTitle size="xs">
                  <h3>S3 Restore Progress</h3>
                </EuiTitle>
                <EuiSpacer size="s" />
                {progressLoading && <EuiLoadingSpinner size="m" />}
                {restoreProgress && restoreProgress.map((rp, i) => {
                  const pct = rp.total > 0 ? Math.round((rp.restored / rp.total) * 100) : 0;
                  return (
                    <div key={i} style={{ marginBottom: 16 }}>
                      <EuiText size="s"><strong>{rp.repo}</strong></EuiText>
                      <EuiSpacer size="xs" />
                      <EuiProgress value={rp.restored} max={rp.total} size="m" color={rp.complete ? 'success' : 'primary'} />
                      <EuiSpacer size="xs" />
                      <EuiText size="xs" color="subdued">
                        {rp.restored}/{rp.total} restored ({pct}%)
                        {rp.in_progress > 0 && ` \u00b7 ${rp.in_progress} in progress`}
                        {rp.not_restored > 0 && ` \u00b7 ${rp.not_restored} pending`}
                        {rp.complete && ' \u00b7 Complete'}
                      </EuiText>
                    </div>
                  );
                })}
                {!progressLoading && !restoreProgress && (
                  <EuiText size="s" color="subdued">Could not load restore progress.</EuiText>
                )}
              </>
            )}
          </EuiFlyoutBody>
        </EuiFlyout>
      )}
    </>
  );
}
