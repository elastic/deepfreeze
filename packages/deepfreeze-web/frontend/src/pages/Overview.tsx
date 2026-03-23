import { useState } from 'react';
import { trimDate } from '../api/util';
import {
  EuiFlexGroup,
  EuiFlexItem,
  EuiPanel,
  EuiStat,
  EuiHealth,
  EuiButton,
  EuiCallOut,
  EuiLoadingSpinner,
  EuiSpacer,
  EuiTitle,
  EuiText,
  EuiFlyout,
  EuiFlyoutHeader,
  EuiFlyoutBody,
  EuiBasicTable,
  EuiBadge,
  type EuiBasicTableColumn,
} from '@elastic/eui';
import { useStatus } from '../hooks/useStatus';
import RefreshControl from '../components/RefreshControl';

type Repo = Record<string, unknown>;
type ThawReq = Record<string, unknown>;
type Bucket = Record<string, unknown>;
type IlmPolicy = Record<string, unknown>;

function clusterHealthColor(status: string): 'success' | 'warning' | 'danger' | 'subdued' {
  switch (status) {
    case 'green': return 'success';
    case 'yellow': return 'warning';
    case 'red': return 'danger';
    default: return 'subdued';
  }
}

function healthStatusColor(s: string) {
  return s === 'green' ? '#00BFB3' : s === 'yellow' ? '#FEC514' : s === 'red' ? '#F66' : 'inherit';
}

function stateColor(state: string): 'success' | 'warning' | 'danger' | 'primary' | 'default' {
  switch (state) {
    case 'active': return 'success';
    case 'frozen': return 'primary';
    case 'thawing': return 'warning';
    case 'thawed': return 'success';
    case 'expired': return 'danger';
    default: return 'default';
  }
}

function thawStatusColor(s: string): string {
  switch (s) {
    case 'completed': return 'success';
    case 'in_progress': case 'pending': return 'warning';
    case 'failed': return 'danger';
    case 'refrozen': return 'primary';
    default: return 'default';
  }
}

// -- Column definitions for each detail flyout --

const repoColumns: EuiBasicTableColumn<Repo>[] = [
  { field: 'name', name: 'Name', sortable: true, render: (v: string) => <strong>{v}</strong> },
  { field: 'thaw_state', name: 'State', sortable: true, render: (v: string) => <EuiBadge color={stateColor(v || 'unknown')}>{v || 'unknown'}</EuiBadge> },
  { field: 'storage_tier', name: 'Storage Tier', sortable: true, render: (v: string) => v || '--' },
  { field: 'is_mounted', name: 'Mounted', render: (v: unknown) => <EuiBadge color={v ? 'success' : 'default'}>{v ? 'Yes' : 'No'}</EuiBadge> },
  { field: 'bucket', name: 'Bucket Path', truncateText: true, render: (_: unknown, item: Repo) => `${item.bucket || ''}/${item.base_path || ''}` },
  {
    field: 'start',
    name: 'Date Range',
    render: (_: unknown, item: Repo) => {
      const start = trimDate(item.start);
      const end = trimDate(item.end);
      if (!start && !end) return '--';
      return <EuiText size="s"><div>{start || '?'}</div><div>{end || '?'}</div></EuiText>;
    },
  },
];

const thawColumns: EuiBasicTableColumn<ThawReq>[] = [
  { field: 'request_id', name: 'Request ID', render: (id: string) => <code>{id ? id.substring(0, 8) : '--'}</code> },
  { field: 'status', name: 'Status', render: (s: string) => <EuiBadge color={thawStatusColor(s || 'unknown')}>{s || 'unknown'}</EuiBadge> },
  {
    field: 'start_date',
    name: 'Date Range',
    render: (_: unknown, item: ThawReq) => {
      const start = trimDate(item.start_date);
      const end = trimDate(item.end_date);
      if (!start && !end) return '--';
      return <EuiText size="s">{start || '?'} &rarr; {end || '?'}</EuiText>;
    },
  },
  { field: 'repos', name: 'Repos', render: (repos: unknown) => Array.isArray(repos) ? repos.length : '--' },
  { field: 'created_at', name: 'Created', render: (ts: string) => ts ? trimDate(ts) : '--' },
];

const bucketColumns: EuiBasicTableColumn<Bucket>[] = [
  { field: 'name', name: 'Bucket Name', sortable: true, render: (v: string) => <strong>{v}</strong> },
  { field: 'object_count', name: 'Objects', sortable: true, render: (v: number) => v >= 0 ? v.toLocaleString() : 'error' },
];

const ilmColumns: EuiBasicTableColumn<IlmPolicy>[] = [
  { field: 'name', name: 'Policy Name', sortable: true, render: (v: string) => <strong>{v}</strong> },
  { field: 'repository', name: 'Repository', sortable: true },
  { field: 'indices_count', name: 'Indices', sortable: true },
  { field: 'data_streams_count', name: 'Data Streams', sortable: true },
  { field: 'templates_count', name: 'Templates', sortable: true },
];

// -- Flyout config type --

interface FlyoutConfig {
  title: string;
  items: Record<string, unknown>[];
  columns: EuiBasicTableColumn<Record<string, unknown>>[];
}

export default function Overview() {
  const { status, loading, error, refresh } = useStatus();
  const [flyout, setFlyout] = useState<FlyoutConfig | null>(null);

  if (loading && !status) {
    return (
      <EuiFlexGroup justifyContent="center" alignItems="center" style={{ minHeight: 300 }}>
        <EuiFlexItem grow={false}><EuiLoadingSpinner size="xl" /></EuiFlexItem>
      </EuiFlexGroup>
    );
  }

  if (error && !status) {
    return (
      <EuiCallOut title="Error loading status" color="danger" iconType="alert">
        <p>{error}</p>
        <EuiButton color="danger" onClick={() => refresh(true)}>Retry</EuiButton>
      </EuiCallOut>
    );
  }

  if (!status) return null;

  const repos = status.repositories || [];
  const stateCounts: Record<string, number> = {};
  for (const repo of repos) {
    const state = (repo.thaw_state as string) || 'unknown';
    stateCounts[state] = (stateCounts[state] || 0) + 1;
  }

  const sortByName = (items: Record<string, unknown>[]) =>
    [...items].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

  const reposByState = (state: string | null) => {
    const filtered = state ? repos.filter((r) => (r.thaw_state || 'unknown') === state) : repos;
    return sortByName(filtered);
  };

  const openRepoFlyout = (title: string, state: string | null) => {
    setFlyout({ title, items: reposByState(state), columns: repoColumns });
  };

  const cardStyle = { cursor: 'pointer' };

  return (
    <>
      <EuiFlexGroup justifyContent="spaceBetween" alignItems="center">
        <EuiFlexItem grow={false}>
          <EuiTitle size="l"><h2>Overview</h2></EuiTitle>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <RefreshControl onRefresh={() => refresh(true)} loading={loading} />
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiSpacer size="l" />

      {/* Cluster Health */}
      <EuiPanel hasBorder>
        <EuiFlexGroup alignItems="center" gutterSize="m">
          <EuiFlexItem grow={false}>
            <EuiHealth color={clusterHealthColor(status.cluster.status)}>
              <EuiText size="m">
                <strong>Cluster: {status.cluster.name}</strong> &mdash;{' '}
                <span style={{ color: healthStatusColor(status.cluster.status), fontWeight: 600 }}>
                  {status.cluster.status}
                </span>
              </EuiText>
            </EuiHealth>
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiText size="s" color="subdued">
              Version {status.cluster.version} &middot; {status.cluster.node_count} node{status.cluster.node_count !== 1 ? 's' : ''}
            </EuiText>
          </EuiFlexItem>
        </EuiFlexGroup>
      </EuiPanel>

      <EuiSpacer size="l" />

      {/* Repository stat cards */}
      <EuiFlexGroup gutterSize="l" wrap>
        <EuiFlexItem>
          <EuiPanel hasBorder style={cardStyle} onClick={() => openRepoFlyout('All Repositories', null)}>
            <EuiStat title={repos.length} description="Total Repositories" titleColor="primary" />
          </EuiPanel>
        </EuiFlexItem>
        <EuiFlexItem>
          <EuiPanel hasBorder style={cardStyle} onClick={() => openRepoFlyout('Active Repositories', 'active')}>
            <EuiStat title={stateCounts['active'] || 0} description="Active" titleColor="success" />
          </EuiPanel>
        </EuiFlexItem>
        <EuiFlexItem>
          <EuiPanel hasBorder style={cardStyle} onClick={() => openRepoFlyout('Frozen Repositories', 'frozen')}>
            <EuiStat title={stateCounts['frozen'] || 0} description="Frozen" titleColor="primary" />
          </EuiPanel>
        </EuiFlexItem>
        <EuiFlexItem>
          <EuiPanel hasBorder style={cardStyle} onClick={() => openRepoFlyout('Thawing Repositories', 'thawing')}>
            <EuiStat title={stateCounts['thawing'] || 0} description="Thawing" titleColor="accent" />
          </EuiPanel>
        </EuiFlexItem>
        <EuiFlexItem>
          <EuiPanel hasBorder style={cardStyle} onClick={() => openRepoFlyout('Thawed Repositories', 'thawed')}>
            <EuiStat title={stateCounts['thawed'] || 0} description="Thawed" titleColor="secondary" />
          </EuiPanel>
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiSpacer size="l" />

      {/* Thaw / Buckets / ILM cards */}
      <EuiFlexGroup gutterSize="l" wrap>
        <EuiFlexItem>
          <EuiPanel
            hasBorder
            style={cardStyle}
            onClick={() => setFlyout({ title: 'Thaw Requests', items: status.thaw_requests, columns: thawColumns })}
          >
            <EuiStat title={status.thaw_requests.length} description="Thaw Requests" titleColor="accent" />
          </EuiPanel>
        </EuiFlexItem>
        <EuiFlexItem>
          <EuiPanel
            hasBorder
            style={cardStyle}
            onClick={() => setFlyout({ title: 'Buckets', items: status.buckets, columns: bucketColumns })}
          >
            <EuiStat title={status.buckets.length} description="Buckets" titleColor="primary" />
          </EuiPanel>
        </EuiFlexItem>
        <EuiFlexItem>
          <EuiPanel
            hasBorder
            style={cardStyle}
            onClick={() => setFlyout({ title: 'ILM Policies', items: status.ilm_policies, columns: ilmColumns })}
          >
            <EuiStat title={status.ilm_policies.length} description="ILM Policies" titleColor="primary" />
          </EuiPanel>
        </EuiFlexItem>
      </EuiFlexGroup>

      {/* Errors */}
      {status.errors.length > 0 && (
        <>
          <EuiSpacer size="l" />
          {status.errors.map((err, i) => (
            <div key={i}>
              <EuiCallOut
                title={`[${err.code}] ${err.message}`}
                color={err.severity === 'error' ? 'danger' : 'warning'}
                iconType={err.severity === 'error' ? 'alert' : 'help'}
              />
              {i < status.errors.length - 1 && <EuiSpacer size="s" />}
            </div>
          ))}
        </>
      )}

      {/* Detail flyout */}
      {flyout && (
        <EuiFlyout onClose={() => setFlyout(null)} size="l" ownFocus>
          <EuiFlyoutHeader hasBorder>
            <EuiTitle size="m">
              <h2>{flyout.title} ({flyout.items.length})</h2>
            </EuiTitle>
          </EuiFlyoutHeader>
          <EuiFlyoutBody>
            <EuiBasicTable
              items={flyout.items}
              columns={flyout.columns}
              noItemsMessage={`No ${flyout.title.toLowerCase()} found`}
            />
          </EuiFlyoutBody>
        </EuiFlyout>
      )}
    </>
  );
}
