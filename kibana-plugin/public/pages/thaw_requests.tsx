import React, { useMemo, useState } from 'react';
import {
  EuiBadge,
  EuiBasicTable,
  EuiButton,
  EuiDescriptionList,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFlyout,
  EuiFlyoutBody,
  EuiFlyoutHeader,
  EuiSpacer,
  EuiText,
  EuiTitle,
  type CriteriaWithPagination,
  type EuiBasicTableColumn,
} from '@elastic/eui';
import type { CoreStart } from '@kbn/core/public';

import { useStatus } from '../hooks/use_status';
import { RefreshControl } from '../components/refresh_control';
import { PageLoading, PageError } from '../components/page_states';
import { RefreezeModal } from '../components/refreeze_modal';
import { trimDate } from '../utils/format';
import type { StatusResult } from '../../server/actions/status';

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

export function ThawRequestsPage({ http, notifications }: ThawRequestsPageProps) {
  const { status, loading, error, refresh } = useStatus(http);
  const [flyoutItem, setFlyoutItem] = useState<ThawReq | null>(null);
  const [refreezeTarget, setRefreezeTarget] = useState<ThawReq | null>(null);
  const [sortField, setSortField] = useState<keyof ThawReq>('created_at');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(20);

  const requests = useMemo<ThawReq[]>(
    () => (status ? status.thaw_requests : []),
    [status]
  );

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
      name: 'Date range',
      render: (_: unknown, item: ThawReq) => {
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
      field: 'repos',
      name: 'Repos',
      render: (repos: unknown) => (Array.isArray(repos) ? repos.length : '--'),
    },
    {
      field: 'created_at',
      name: 'Created',
      sortable: true,
      render: (ts: string) => (ts ? trimDate(ts) : '--'),
    },
  ];

  const onTableChange = ({ page, sort }: CriteriaWithPagination<ThawReq>) => {
    if (page) {
      setPageIndex(page.index);
      setPageSize(page.size);
    }
    if (sort) {
      setSortField(sort.field as keyof ThawReq);
      setSortDirection(sort.direction);
    }
  };

  return (
    <>
      <EuiFlexGroup justifyContent="spaceBetween" alignItems="center">
        <EuiFlexItem grow={false}>
          <EuiTitle size="m">
            <h2>Thaw requests</h2>
          </EuiTitle>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <RefreshControl onRefresh={refresh} loading={loading} />
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiSpacer size="m" />

      <EuiBasicTable
        items={paged}
        columns={columns}
        sorting={{ sort: { field: sortField, direction: sortDirection } }}
        pagination={{
          pageIndex,
          pageSize,
          totalItemCount: sorted.length,
          pageSizeOptions: [10, 20, 50],
        }}
        onChange={onTableChange}
        rowProps={(item: ThawReq) => ({
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
                  description: trimDate(flyoutItem.created_at) || '--',
                },
                {
                  title: 'Date range',
                  description: `${trimDate(flyoutItem.start_date) || '?'} → ${
                    trimDate(flyoutItem.end_date) || '?'
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
    </>
  );
}
