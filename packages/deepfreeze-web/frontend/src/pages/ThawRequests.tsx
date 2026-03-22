import { useState, useMemo } from 'react';
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
  type CriteriaWithPagination,
  type EuiBasicTableColumn,
} from '@elastic/eui';
import { useStatus } from '../hooks/useStatus';

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

export default function ThawRequests() {
  const { status, loading, error, refresh } = useStatus();
  const [flyoutItem, setFlyoutItem] = useState<ThawRequest | null>(null);
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
          <EuiButton
            iconType="refresh"
            onClick={() => refresh(true)}
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
          pageSizeOptions: [10, 20, 50],
        }}
        onChange={onTableChange}
        rowProps={(item: ThawRequest) => ({
          onClick: () => setFlyoutItem(item),
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
            <EuiDescriptionList
              type="column"
              compressed
              listItems={Object.entries(flyoutItem)
                .filter(([key]) => key !== 'repositories')
                .filter(([, v]) => v !== null && v !== undefined)
                .map(([key, value]) => ({
                  title: key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
                  description:
                    typeof value === 'object'
                      ? JSON.stringify(value, null, 2)
                      : String(value),
                }))}
            />

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
          </EuiFlyoutBody>
        </EuiFlyout>
      )}
    </>
  );
}
