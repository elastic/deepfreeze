import { useState, useEffect, useCallback } from 'react';
import { trimDate } from '../api/util';
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
  EuiFlyout,
  EuiFlyoutBody,
  EuiFlyoutHeader,
  EuiDescriptionList,
  EuiCodeBlock,
  type EuiBasicTableColumn,
  type CriteriaWithPagination,
} from '@elastic/eui';
import { api, type AuditEntry } from '../api/client';
import RefreshControl from '../components/RefreshControl';

export default function Activity() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortField, setSortField] = useState<keyof AuditEntry>('timestamp');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [flyoutEntry, setFlyoutEntry] = useState<AuditEntry | null>(null);

  const fetchAudit = useCallback(async () => {
    try {
      setLoading(true);
      const data = await api.getAuditLog(100);
      setEntries(data.entries);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAudit();
  }, [fetchAudit]);

  const sorted = [...entries].sort((a, b) => {
    const aVal = String(a[sortField] ?? '');
    const bVal = String(b[sortField] ?? '');
    return sortDirection === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
  });

  const paged = sorted.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);

  const columns: EuiBasicTableColumn<AuditEntry>[] = [
    {
      field: 'timestamp',
      name: 'Timestamp',
      sortable: true,
      render: (ts: string) => (ts ? trimDate(ts) : '--'),
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
      field: 'user',
      name: 'User',
      sortable: true,
      render: (user: string) => (
        <EuiText size="s">{user || '--'}</EuiText>
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
      name: 'Status',
      sortable: true,
      render: (success: boolean) => (
        <EuiIcon
          type={success ? 'checkInCircleFilled' : 'cross'}
          color={success ? 'success' : 'danger'}
          size="m"
        />
      ),
    },
    {
      field: 'duration_ms',
      name: 'Duration',
      sortable: true,
      render: (ms: number) => {
        if (!ms && ms !== 0) return '--';
        if (ms < 1000) return `${ms}ms`;
        return `${(ms / 1000).toFixed(1)}s`;
      },
    },
    {
      field: 'errors',
      name: 'Errors',
      render: (errors: unknown[]) => {
        const count = Array.isArray(errors) ? errors.length : 0;
        return count > 0 ? (
          <EuiBadge color="danger">{count}</EuiBadge>
        ) : (
          <EuiText size="s" color="subdued">0</EuiText>
        );
      },
    },
  ];

  const onTableChange = ({ page, sort }: CriteriaWithPagination<AuditEntry>) => {
    if (page) {
      setPageIndex(page.index);
      setPageSize(page.size);
    }
    if (sort) {
      setSortField(sort.field as keyof AuditEntry);
      setSortDirection(sort.direction);
    }
  };

  if (loading && entries.length === 0) {
    return (
      <EuiFlexGroup justifyContent="center" alignItems="center" style={{ minHeight: 300 }}>
        <EuiFlexItem grow={false}>
          <EuiLoadingSpinner size="xl" />
        </EuiFlexItem>
      </EuiFlexGroup>
    );
  }

  if (error && entries.length === 0) {
    return (
      <EuiCallOut title="Error loading audit log" color="danger" iconType="alert">
        <p>{error}</p>
        <EuiButton color="danger" onClick={fetchAudit}>
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
          <RefreshControl onRefresh={fetchAudit} loading={loading} />
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
        rowProps={(item: AuditEntry) => ({
          onClick: () => setFlyoutEntry(item),
          style: { cursor: 'pointer' },
        })}
        noItemsMessage="No audit entries found"
      />

      {flyoutEntry && (
        <EuiFlyout onClose={() => setFlyoutEntry(null)} size="m" ownFocus>
          <EuiFlyoutHeader hasBorder>
            <EuiTitle size="m">
              <h2>
                <EuiBadge color="hollow">{flyoutEntry.action}</EuiBadge>
                {' '}
                {trimDate(flyoutEntry.timestamp)}
              </h2>
            </EuiTitle>
          </EuiFlyoutHeader>
          <EuiFlyoutBody>
            <EuiDescriptionList
              type="column"
              compressed
              listItems={[
                { title: 'Action', description: flyoutEntry.action },
                { title: 'Timestamp', description: trimDate(flyoutEntry.timestamp) || '--' },
                { title: 'User', description: flyoutEntry.user || '--' },
                { title: 'Hostname', description: flyoutEntry.hostname || '--' },
                { title: 'Success', description: flyoutEntry.success ? 'Yes' : 'No' },
                { title: 'Dry Run', description: flyoutEntry.dry_run ? 'Yes' : 'No' },
                { title: 'Duration', description: flyoutEntry.duration_ms < 1000 ? `${flyoutEntry.duration_ms}ms` : `${(flyoutEntry.duration_ms / 1000).toFixed(1)}s` },
                { title: 'Version', description: flyoutEntry.version || '--' },
              ]}
            />

            {flyoutEntry.parameters && Object.keys(flyoutEntry.parameters).length > 0 && (
              <>
                <EuiSpacer size="l" />
                <EuiTitle size="xs"><h3>Parameters</h3></EuiTitle>
                <EuiSpacer size="s" />
                <EuiCodeBlock language="json" fontSize="s" paddingSize="m">
                  {JSON.stringify(flyoutEntry.parameters, null, 2)}
                </EuiCodeBlock>
              </>
            )}

            {flyoutEntry.summary && Object.keys(flyoutEntry.summary).length > 0 && (
              <>
                <EuiSpacer size="l" />
                <EuiTitle size="xs"><h3>Summary</h3></EuiTitle>
                <EuiSpacer size="s" />
                <EuiCodeBlock language="json" fontSize="s" paddingSize="m">
                  {JSON.stringify(flyoutEntry.summary, null, 2)}
                </EuiCodeBlock>
              </>
            )}

            {flyoutEntry.results && flyoutEntry.results.length > 0 && (
              <>
                <EuiSpacer size="l" />
                <EuiTitle size="xs"><h3>Results ({flyoutEntry.results.length})</h3></EuiTitle>
                <EuiSpacer size="s" />
                <EuiCodeBlock language="json" fontSize="s" paddingSize="m">
                  {JSON.stringify(flyoutEntry.results, null, 2)}
                </EuiCodeBlock>
              </>
            )}

            {flyoutEntry.errors && flyoutEntry.errors.length > 0 && (
              <>
                <EuiSpacer size="l" />
                <EuiTitle size="xs"><h3>Errors ({flyoutEntry.errors.length})</h3></EuiTitle>
                <EuiSpacer size="s" />
                {flyoutEntry.errors.map((err, i) => (
                  <EuiCallOut
                    key={i}
                    title={err.code}
                    color="danger"
                    iconType="alert"
                    size="s"
                  >
                    <p>{err.message}</p>
                  </EuiCallOut>
                ))}
              </>
            )}
          </EuiFlyoutBody>
        </EuiFlyout>
      )}
    </>
  );
}
