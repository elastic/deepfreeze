import React, { useMemo, useState } from 'react';
import {
  EuiBadge,
  EuiBasicTable,
  EuiButton,
  EuiDescriptionList,
  EuiFieldSearch,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFlyout,
  EuiFlyoutBody,
  EuiFlyoutHeader,
  EuiHealth,
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
import { RepairMetadataModal } from '../components/repair_metadata_modal';
import { formatStoredDatetime } from '../utils/format';
import type { StatusResult } from '../../server/actions/status';

type Repo = StatusResult['repositories'][number];

interface RepositoriesPageProps {
  http: CoreStart['http'];
  notifications: CoreStart['notifications'];
}

function stateHealthColor(
  state: string
): 'success' | 'warning' | 'danger' | 'primary' | 'subdued' {
  switch (state) {
    case 'active':
      return 'success';
    case 'frozen':
      return 'primary';
    case 'thawing':
      return 'warning';
    case 'thawed':
      return 'success';
    case 'expired':
      return 'danger';
    default:
      return 'subdued';
  }
}

export function RepositoriesPage({ http, notifications }: RepositoriesPageProps) {
  const { status, loading, error, refresh } = useStatus(http);
  const [search, setSearch] = useState('');
  const [flyoutRepo, setFlyoutRepo] = useState<Repo | null>(null);
  const [repairOpen, setRepairOpen] = useState(false);
  const [sortField, setSortField] = useState<keyof Repo>('name');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(20);

  const repos = useMemo<Repo[]>(() => {
    if (!status) return [];
    let list = status.repositories || [];
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((r) => {
        const name = String(r.name || '').toLowerCase();
        const basePath = String(r.base_path || '').toLowerCase();
        return name.includes(q) || basePath.includes(q);
      });
    }
    return list;
  }, [status, search]);

  const sorted = useMemo(() => {
    const copy = [...repos];
    copy.sort((a, b) => {
      const aVal = String(a[sortField] ?? '');
      const bVal = String(b[sortField] ?? '');
      return sortDirection === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    });
    return copy;
  }, [repos, sortField, sortDirection]);

  const paged = sorted.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);

  if (loading && !status) return <PageLoading />;
  if (error && !status) return <PageError message={error} onRetry={refresh} />;

  const columns: Array<EuiBasicTableColumn<Repo>> = [
    {
      field: 'name',
      name: 'Name',
      sortable: true,
      render: (name: string) => <strong>{name}</strong>,
    },
    {
      field: 'bucket',
      name: 'Bucket path',
      sortable: true,
      truncateText: true,
      render: (_: unknown, item: Repo) => `${item.bucket || ''}/${item.base_path || ''}`,
    },
    {
      field: 'start',
      name: 'Date range',
      render: (_: unknown, item: Repo) => {
        const start = formatStoredDatetime(item.start);
        const end = formatStoredDatetime(item.end);
        if (!start && !end) {
          return (
            <EuiText size="s" color="subdued">
              --
            </EuiText>
          );
        }
        return (
          <EuiText size="s">
            <div>{start || '?'}</div>
            <div>{end || '?'}</div>
          </EuiText>
        );
      },
    },
    {
      field: 'is_mounted',
      name: 'Mounted',
      sortable: true,
      render: (mounted: boolean) => (
        <EuiBadge color={mounted ? 'success' : 'default'}>{mounted ? 'Yes' : 'No'}</EuiBadge>
      ),
    },
    {
      field: 'thaw_state',
      name: 'State',
      sortable: true,
      render: (state: string) => (
        <EuiHealth color={stateHealthColor(state || 'unknown')}>{state || 'unknown'}</EuiHealth>
      ),
    },
  ];

  const onTableChange = ({ page, sort }: CriteriaWithPagination<Repo>) => {
    if (page) {
      setPageIndex(page.index);
      setPageSize(page.size);
    }
    if (sort) {
      setSortField(sort.field as keyof Repo);
      setSortDirection(sort.direction);
    }
  };

  return (
    <>
      <EuiFlexGroup justifyContent="spaceBetween" alignItems="center">
        <EuiFlexItem grow={false}>
          <EuiTitle size="m">
            <h2>Repositories</h2>
          </EuiTitle>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiFlexGroup gutterSize="s" alignItems="center">
            <EuiFlexItem grow={false}>
              <EuiButton iconType="wrench" onClick={() => setRepairOpen(true)}>
                Repair metadata
              </EuiButton>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <RefreshControl onRefresh={refresh} loading={loading} />
            </EuiFlexItem>
          </EuiFlexGroup>
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiSpacer size="m" />

      <EuiFieldSearch
        placeholder="Search repositories..."
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setPageIndex(0);
        }}
        fullWidth
        aria-label="Search repositories"
      />

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
        rowProps={(item: Repo) => ({
          onClick: () => setFlyoutRepo(item),
          style: { cursor: 'pointer' },
        })}
        noItemsMessage="No repositories found"
      />

      {flyoutRepo && (
        <EuiFlyout onClose={() => setFlyoutRepo(null)} size="m" ownFocus>
          <EuiFlyoutHeader hasBorder>
            <EuiTitle size="m">
              <h2>{String(flyoutRepo.name || 'Repository details')}</h2>
            </EuiTitle>
          </EuiFlyoutHeader>
          <EuiFlyoutBody>
            <EuiDescriptionList
              type="column"
              compressed
              listItems={Object.entries(flyoutRepo)
                .filter(([, v]) => v !== null && v !== undefined)
                .map(([key, value]) => ({
                  title: key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
                  description:
                    typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value),
                }))}
            />
          </EuiFlyoutBody>
        </EuiFlyout>
      )}

      {repairOpen && (
        <RepairMetadataModal
          http={http}
          notifications={notifications}
          onClose={() => setRepairOpen(false)}
          onComplete={refresh}
        />
      )}
    </>
  );
}
