import React, { useCallback, useEffect, useState } from 'react';
import {
  EuiBadge,
  EuiBasicTable,
  EuiCallOut,
  EuiCodeBlock,
  EuiDescriptionList,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFlyout,
  EuiFlyoutBody,
  EuiFlyoutHeader,
  EuiIcon,
  EuiSpacer,
  EuiText,
  EuiTitle,
  type CriteriaWithPagination,
  type EuiBasicTableColumn,
} from '@elastic/eui';
import type { CoreStart } from '@kbn/core/public';

import { API } from '../../common/api/paths';
import { RefreshControl } from '../components/refresh_control';
import { PageLoading, PageError } from '../components/page_states';
import { formatTimestamp, formatDuration } from '../utils/format';
import type { AuditEntryDoc } from '../../common/schemas/audit_entry';

interface ActivityPageProps {
  http: CoreStart['http'];
}

interface AuditResponse {
  entries: AuditEntryDoc[];
  source: string;
}

export function ActivityPage({ http }: ActivityPageProps) {
  const [entries, setEntries] = useState<AuditEntryDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortField, setSortField] = useState<keyof AuditEntryDoc>('timestamp');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [flyoutEntry, setFlyoutEntry] = useState<AuditEntryDoc | null>(null);

  const fetchAudit = useCallback(async () => {
    try {
      setLoading(true);
      const data = await http.get<AuditResponse>(API.audit, { query: { limit: 100 } });
      setEntries(data.entries);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [http]);

  useEffect(() => {
    fetchAudit();
  }, [fetchAudit]);

  const sorted = [...entries].sort((a, b) => {
    const aVal = String(a[sortField] ?? '');
    const bVal = String(b[sortField] ?? '');
    return sortDirection === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
  });

  const paged = sorted.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);

  if (loading && entries.length === 0) return <PageLoading />;
  if (error && entries.length === 0) {
    return <PageError message={error} onRetry={fetchAudit} title="Error loading audit log" />;
  }

  const columns: Array<EuiBasicTableColumn<AuditEntryDoc>> = [
    {
      field: 'timestamp',
      name: 'Timestamp',
      sortable: true,
      render: (ts: string) => (ts ? formatTimestamp(ts) : '--'),
    },
    {
      field: 'action',
      name: 'Action',
      sortable: true,
      render: (action: string) => <EuiBadge color="hollow">{action}</EuiBadge>,
    },
    {
      field: 'user',
      name: 'User',
      sortable: true,
      render: (user: string) => <EuiText size="s">{user || '--'}</EuiText>,
    },
    {
      field: 'dry_run',
      name: 'Dry run',
      sortable: true,
      render: (dryRun: boolean) =>
        dryRun ? (
          <EuiBadge color="warning">Yes</EuiBadge>
        ) : (
          <EuiText size="s" color="subdued">
            No
          </EuiText>
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
      render: (ms: number) => formatDuration(ms),
    },
    {
      field: 'errors',
      name: 'Errors',
      render: (errs: unknown[]) => {
        const count = Array.isArray(errs) ? errs.length : 0;
        return count > 0 ? (
          <EuiBadge color="danger">{count}</EuiBadge>
        ) : (
          <EuiText size="s" color="subdued">
            0
          </EuiText>
        );
      },
    },
  ];

  const onTableChange = ({ page, sort }: CriteriaWithPagination<AuditEntryDoc>) => {
    if (page) {
      setPageIndex(page.index);
      setPageSize(page.size);
    }
    if (sort) {
      setSortField(sort.field as keyof AuditEntryDoc);
      setSortDirection(sort.direction);
    }
  };

  return (
    <>
      <EuiFlexGroup justifyContent="spaceBetween" alignItems="center">
        <EuiFlexItem grow={false}>
          <EuiTitle size="m">
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
        sorting={{ sort: { field: sortField, direction: sortDirection } }}
        pagination={{
          pageIndex,
          pageSize,
          totalItemCount: sorted.length,
          pageSizeOptions: [10, 25, 50, 100],
        }}
        onChange={onTableChange}
        rowProps={(item: AuditEntryDoc) => ({
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
                <EuiBadge color="hollow">{flyoutEntry.action}</EuiBadge>{' '}
                {formatTimestamp(flyoutEntry.timestamp)}
              </h2>
            </EuiTitle>
          </EuiFlyoutHeader>
          <EuiFlyoutBody>
            <EuiDescriptionList
              type="column"
              compressed
              listItems={[
                { title: 'Action', description: flyoutEntry.action },
                { title: 'Timestamp', description: formatTimestamp(flyoutEntry.timestamp) || '--' },
                { title: 'User', description: flyoutEntry.user || '--' },
                { title: 'Hostname', description: flyoutEntry.hostname || '--' },
                { title: 'Success', description: flyoutEntry.success ? 'Yes' : 'No' },
                { title: 'Dry run', description: flyoutEntry.dry_run ? 'Yes' : 'No' },
                { title: 'Duration', description: formatDuration(flyoutEntry.duration_ms) },
                { title: 'Version', description: flyoutEntry.version || '--' },
              ]}
            />

            {flyoutEntry.parameters && Object.keys(flyoutEntry.parameters).length > 0 && (
              <>
                <EuiSpacer size="l" />
                <EuiTitle size="xs">
                  <h3>Parameters</h3>
                </EuiTitle>
                <EuiSpacer size="s" />
                <EuiCodeBlock language="json" fontSize="s" paddingSize="m">
                  {JSON.stringify(flyoutEntry.parameters, null, 2)}
                </EuiCodeBlock>
              </>
            )}

            {flyoutEntry.summary && Object.keys(flyoutEntry.summary).length > 0 && (
              <>
                <EuiSpacer size="l" />
                <EuiTitle size="xs">
                  <h3>Summary</h3>
                </EuiTitle>
                <EuiSpacer size="s" />
                <EuiCodeBlock language="json" fontSize="s" paddingSize="m">
                  {JSON.stringify(flyoutEntry.summary, null, 2)}
                </EuiCodeBlock>
              </>
            )}

            {Array.isArray(flyoutEntry.results) && flyoutEntry.results.length > 0 && (
              <>
                <EuiSpacer size="l" />
                <EuiTitle size="xs">
                  <h3>Results ({flyoutEntry.results.length})</h3>
                </EuiTitle>
                <EuiSpacer size="s" />
                <EuiCodeBlock language="json" fontSize="s" paddingSize="m">
                  {JSON.stringify(flyoutEntry.results, null, 2)}
                </EuiCodeBlock>
              </>
            )}

            {Array.isArray(flyoutEntry.errors) && flyoutEntry.errors.length > 0 && (
              <>
                <EuiSpacer size="l" />
                <EuiTitle size="xs">
                  <h3>Errors ({flyoutEntry.errors.length})</h3>
                </EuiTitle>
                <EuiSpacer size="s" />
                {(flyoutEntry.errors as Array<{ code?: string; message?: string }>).map(
                  (err, i) => (
                    <EuiCallOut
                      key={i}
                      title={err.code || 'Error'}
                      color="danger"
                      iconType="alert"
                      size="s"
                    >
                      <p>{err.message || ''}</p>
                    </EuiCallOut>
                  )
                )}
              </>
            )}
          </EuiFlyoutBody>
        </EuiFlyout>
      )}
    </>
  );
}
