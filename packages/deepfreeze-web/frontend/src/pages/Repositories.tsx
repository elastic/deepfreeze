import { useState, useMemo } from 'react';
import { trimDate } from '../api/util';
import {
  EuiBasicTable,
  EuiFieldSearch,
  EuiFlyout,
  EuiFlyoutBody,
  EuiFlyoutHeader,
  EuiTitle,
  EuiBadge,
  EuiHealth,
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
import RefreshControl from '../components/RefreshControl';

type Repo = Record<string, unknown>;

function stateColor(state: string): 'success' | 'warning' | 'danger' | 'primary' | 'default' {
  switch (state) {
    case 'active':
      return 'success';
    case 'frozen':
      return 'primary';
    case 'thawing':
      return 'warning';
    case 'thawed':
      return 'success';
    default:
      return 'default';
  }
}

export default function Repositories() {
  const { status, loading, error, refresh } = useStatus();
  const [search, setSearch] = useState('');
  const [flyoutRepo, setFlyoutRepo] = useState<Repo | null>(null);
  const [sortField, setSortField] = useState<string>('name');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(20);

  const repos: Repo[] = useMemo(() => {
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

  const columns: EuiBasicTableColumn<Repo>[] = [
    {
      field: 'name',
      name: 'Name',
      sortable: true,
      render: (name: string) => <strong>{name}</strong>,
    },
    {
      field: 'base_path',
      name: 'Base Path',
      sortable: true,
      truncateText: true,
    },
    {
      field: 'date_range',
      name: 'Date Range',
      sortable: true,
      render: (_: unknown, item: Repo) => {
        const start = trimDate(item.start);
        const end = trimDate(item.end);
        if (!start && !end) return <EuiText size="s" color="subdued">--</EuiText>;
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
      render: (mounted: unknown) => (
        <EuiBadge color={mounted ? 'success' : 'default'}>
          {mounted ? 'Yes' : 'No'}
        </EuiBadge>
      ),
    },
    {
      field: 'thaw_state',
      name: 'State',
      sortable: true,
      render: (state: string) => (
        <EuiHealth color={stateColor(state || 'unknown')}>
          {state || 'unknown'}
        </EuiHealth>
      ),
    },
    {
      field: 'storage_tier',
      name: 'Tier',
      sortable: true,
      render: (tier: string) => tier || '--',
    },
  ];

  const onTableChange = ({ page, sort }: CriteriaWithPagination<Repo>) => {
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
      <EuiCallOut title="Error loading repositories" color="danger" iconType="alert">
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
            <h2>Repositories</h2>
          </EuiTitle>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <RefreshControl onRefresh={() => refresh(true)} loading={loading} />
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
      />

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
              <h2>{String(flyoutRepo.name || 'Repository Details')}</h2>
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
                    typeof value === 'object'
                      ? JSON.stringify(value, null, 2)
                      : String(value),
                }))}
            />
          </EuiFlyoutBody>
        </EuiFlyout>
      )}
    </>
  );
}
