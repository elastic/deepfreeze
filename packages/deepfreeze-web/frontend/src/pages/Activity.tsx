import { useState, useEffect, useCallback } from 'react';
import {
  EuiBasicTable,
  EuiTitle,
  EuiSpacer,
  EuiFlexGroup,
  EuiFlexItem,
  EuiButton,
  EuiLoadingSpinner,
  EuiCallOut,
  EuiBadge,
  EuiIcon,
  EuiText,
  type EuiBasicTableColumn,
  type CriteriaWithPagination,
} from '@elastic/eui';
import { api, type ActionHistoryEntry } from '../api/client';

export default function Activity() {
  const [history, setHistory] = useState<ActionHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortField, setSortField] = useState<keyof ActionHistoryEntry>('timestamp');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(25);

  const fetchHistory = useCallback(async () => {
    try {
      setLoading(true);
      const data = await api.getHistory(100);
      setHistory(data.history);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHistory();
    const interval = setInterval(fetchHistory, 15000);
    return () => clearInterval(interval);
  }, [fetchHistory]);

  const sorted = [...history].sort((a, b) => {
    const aVal = String(a[sortField] ?? '');
    const bVal = String(b[sortField] ?? '');
    return sortDirection === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
  });

  const paged = sorted.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);

  const columns: EuiBasicTableColumn<ActionHistoryEntry>[] = [
    {
      field: 'timestamp',
      name: 'Timestamp',
      sortable: true,
      render: (ts: string) => {
        if (!ts) return '--';
        try {
          return new Date(ts).toLocaleString();
        } catch {
          return ts;
        }
      },
    },
    {
      field: 'action',
      name: 'Action',
      sortable: true,
      render: (action: string) => (
        <EuiBadge color="hollow">{action}</EuiBadge>
      ),
    },
    {
      field: 'dry_run',
      name: 'Dry Run',
      sortable: true,
      render: (dryRun: boolean) =>
        dryRun ? (
          <EuiBadge color="warning">Yes</EuiBadge>
        ) : (
          <EuiText size="s" color="subdued">No</EuiText>
        ),
    },
    {
      field: 'success',
      name: 'Success',
      sortable: true,
      render: (success: boolean) => (
        <EuiIcon
          type={success ? 'checkInCircleFilled' : 'crossInCircleFilled'}
          color={success ? 'success' : 'danger'}
          size="m"
        />
      ),
    },
    {
      field: 'summary',
      name: 'Summary',
      truncateText: true,
      render: (summary: string) => (
        <EuiText size="s">{summary || '--'}</EuiText>
      ),
    },
    {
      field: 'error_count',
      name: 'Errors',
      sortable: true,
      render: (count: number) =>
        count > 0 ? (
          <EuiBadge color="danger">{count}</EuiBadge>
        ) : (
          <EuiText size="s" color="subdued">0</EuiText>
        ),
    },
  ];

  const onTableChange = ({ page, sort }: CriteriaWithPagination<ActionHistoryEntry>) => {
    if (page) {
      setPageIndex(page.index);
      setPageSize(page.size);
    }
    if (sort) {
      setSortField(sort.field as keyof ActionHistoryEntry);
      setSortDirection(sort.direction);
    }
  };

  if (loading && history.length === 0) {
    return (
      <EuiFlexGroup justifyContent="center" alignItems="center" style={{ minHeight: 300 }}>
        <EuiFlexItem grow={false}>
          <EuiLoadingSpinner size="xl" />
        </EuiFlexItem>
      </EuiFlexGroup>
    );
  }

  if (error && history.length === 0) {
    return (
      <EuiCallOut title="Error loading activity history" color="danger" iconType="alert">
        <p>{error}</p>
        <EuiButton color="danger" onClick={fetchHistory}>
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
            <h2>Activity</h2>
          </EuiTitle>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiButton
            iconType="refresh"
            onClick={fetchHistory}
            isLoading={loading}
            size="s"
          >
            Refresh
          </EuiButton>
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
          pageSizeOptions: [10, 25, 50, 100],
        }}
        onChange={onTableChange}
        noItemsMessage="No activity history found"
      />
    </>
  );
}
