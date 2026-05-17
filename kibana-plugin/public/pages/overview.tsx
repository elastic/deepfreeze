import React, { useState } from 'react';
import {
  EuiBadge,
  EuiBasicTable,
  EuiCallOut,
  EuiDescriptionList,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFlyout,
  EuiFlyoutBody,
  EuiFlyoutHeader,
  EuiHealth,
  EuiPanel,
  EuiSpacer,
  EuiStat,
  EuiText,
  EuiTitle,
  type EuiBasicTableColumn,
  type EuiHealthProps,
} from '@elastic/eui';
import type { CoreStart } from '@kbn/core/public';

import { useStatus } from '../hooks/use_status';
import { RefreshControl } from '../components/refresh_control';
import { PageLoading, PageError } from '../components/page_states';
import { trimDate } from '../utils/format';
import { SetupWizard } from './setup_wizard';
import type { StatusResult } from '../../server/actions/status';

interface OverviewPageProps {
  http: CoreStart['http'];
}

type Repo = StatusResult['repositories'][number];
type ThawReq = StatusResult['thaw_requests'][number];
type IlmPolicy = StatusResult['ilm_policies'][number];

function clusterHealthColor(status: string): EuiHealthProps['color'] {
  switch (status) {
    case 'green':
      return 'success';
    case 'yellow':
      return 'warning';
    case 'red':
      return 'danger';
    default:
      return 'subdued';
  }
}

function stateBadgeColor(
  state: string
): 'success' | 'warning' | 'danger' | 'primary' | 'default' {
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
      return 'default';
  }
}

function thawStatusColor(
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

const repoColumns: Array<EuiBasicTableColumn<Repo>> = [
  {
    field: 'name',
    name: 'Name',
    sortable: true,
    render: (v: string) => <strong>{v}</strong>,
  },
  {
    field: 'bucket',
    name: 'Bucket path',
    truncateText: true,
    render: (_: unknown, item: Repo) => `${item.bucket || ''}/${item.base_path || ''}`,
  },
  {
    field: 'start',
    name: 'Date range',
    render: (_: unknown, item: Repo) => {
      const start = trimDate(item.start);
      const end = trimDate(item.end);
      if (!start && !end) return '--';
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
    render: (v: boolean) => (
      <EuiBadge color={v ? 'success' : 'default'}>{v ? 'Yes' : 'No'}</EuiBadge>
    ),
  },
  {
    field: 'thaw_state',
    name: 'State',
    sortable: true,
    render: (v: string) => (
      <EuiBadge color={stateBadgeColor(v || 'unknown')}>{v || 'unknown'}</EuiBadge>
    ),
  },
];

const thawColumns: Array<EuiBasicTableColumn<ThawReq>> = [
  {
    field: 'request_id',
    name: 'Request ID',
    render: (id: string) => <code>{id ? id.substring(0, 8) : '--'}</code>,
  },
  {
    field: 'status',
    name: 'Status',
    render: (s: string) => (
      <EuiBadge color={thawStatusColor(s || 'unknown')}>{s || 'unknown'}</EuiBadge>
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
    render: (ts: string) => (ts ? trimDate(ts) : '--'),
  },
];

const ilmColumns: Array<EuiBasicTableColumn<IlmPolicy>> = [
  { field: 'name', name: 'Policy name', sortable: true, render: (v: string) => <strong>{v}</strong> },
  { field: 'repository', name: 'Repository', sortable: true },
  { field: 'indices_count', name: 'Indices', sortable: true },
  { field: 'data_streams_count', name: 'Data streams', sortable: true },
  { field: 'templates_count', name: 'Templates', sortable: true },
];

type FlyoutState =
  | { kind: 'repo'; title: string; items: Repo[] }
  | { kind: 'thaw'; title: string; items: ThawReq[] }
  | { kind: 'ilm'; title: string; items: IlmPolicy[] };

export function OverviewPage({ http }: OverviewPageProps) {
  const { status, loading, error, refresh } = useStatus(http);
  const [flyout, setFlyout] = useState<FlyoutState | null>(null);
  const [detailRepo, setDetailRepo] = useState<Repo | null>(null);
  const [detailThaw, setDetailThaw] = useState<ThawReq | null>(null);

  if (loading && !status) return <PageLoading />;
  if (error && !status) return <PageError message={error} onRetry={refresh} />;
  if (!status) return null;

  const cardStyle: React.CSSProperties = { cursor: 'pointer' };

  if (!status.initialized) {
    return (
      <>
        <SetupWizard http={http} onComplete={refresh} />
        <ErrorCallouts errors={status.errors} />
      </>
    );
  }

  const repos: Repo[] = status.repositories;
  const stateCounts: Record<string, number> = {};
  for (const repo of repos) {
    const s = repo.thaw_state || 'unknown';
    stateCounts[s] = (stateCounts[s] || 0) + 1;
  }

  const reposByState = (state: string | null): Repo[] => {
    const filtered = state ? repos.filter((r) => (r.thaw_state || 'unknown') === state) : repos;
    return [...filtered].sort((a, b) => a.name.localeCompare(b.name));
  };

  const openRepoFlyout = (title: string, state: string | null) =>
    setFlyout({ kind: 'repo', title, items: reposByState(state) });

  const closeDetail = () => {
    setDetailRepo(null);
    setDetailThaw(null);
  };

  return (
    <>
      <RefreshHeader loading={loading} onRefresh={refresh} />

      <EuiSpacer size="l" />

      <EuiPanel hasBorder>
        <EuiFlexGroup alignItems="center" gutterSize="m">
          <EuiFlexItem grow={false}>
            <EuiHealth color={clusterHealthColor(status.cluster.status)}>
              <EuiText size="m">
                <strong>Cluster: {status.cluster.name || '(unnamed)'}</strong> &mdash;{' '}
                {status.cluster.status}
              </EuiText>
            </EuiHealth>
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiText size="s" color="subdued">
              Version {status.cluster.version || '?'} &middot; {status.cluster.node_count} node
              {status.cluster.node_count !== 1 ? 's' : ''}
            </EuiText>
          </EuiFlexItem>
        </EuiFlexGroup>
      </EuiPanel>

      <EuiSpacer size="l" />

      <EuiFlexGroup gutterSize="l" wrap>
        <EuiFlexItem>
          <EuiPanel hasBorder style={cardStyle} onClick={() => openRepoFlyout('All repositories', null)}>
            <EuiStat title={repos.length} description="Total repositories" titleColor="primary" />
          </EuiPanel>
        </EuiFlexItem>
        <EuiFlexItem>
          <EuiPanel hasBorder style={cardStyle} onClick={() => openRepoFlyout('Active repositories', 'active')}>
            <EuiStat title={stateCounts.active || 0} description="Active" titleColor="success" />
          </EuiPanel>
        </EuiFlexItem>
        <EuiFlexItem>
          <EuiPanel hasBorder style={cardStyle} onClick={() => openRepoFlyout('Frozen repositories', 'frozen')}>
            <EuiStat title={stateCounts.frozen || 0} description="Frozen" titleColor="primary" />
          </EuiPanel>
        </EuiFlexItem>
        <EuiFlexItem>
          <EuiPanel hasBorder style={cardStyle} onClick={() => openRepoFlyout('Thawing repositories', 'thawing')}>
            <EuiStat title={stateCounts.thawing || 0} description="Thawing" titleColor="accent" />
          </EuiPanel>
        </EuiFlexItem>
        <EuiFlexItem>
          <EuiPanel hasBorder style={cardStyle} onClick={() => openRepoFlyout('Thawed repositories', 'thawed')}>
            <EuiStat title={stateCounts.thawed || 0} description="Thawed" titleColor="success" />
          </EuiPanel>
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiSpacer size="l" />

      <EuiFlexGroup gutterSize="l" wrap>
        <EuiFlexItem>
          <EuiPanel
            hasBorder
            style={cardStyle}
            onClick={() =>
              setFlyout({ kind: 'thaw', title: 'Thaw requests', items: status.thaw_requests })
            }
          >
            <EuiStat
              title={status.thaw_requests.length}
              description="Thaw requests"
              titleColor="accent"
            />
          </EuiPanel>
        </EuiFlexItem>
        <EuiFlexItem>
          <EuiPanel
            hasBorder
            style={cardStyle}
            onClick={() =>
              setFlyout({ kind: 'ilm', title: 'ILM policies', items: status.ilm_policies })
            }
          >
            <EuiStat
              title={status.ilm_policies.length}
              description="ILM policies"
              titleColor="primary"
            />
          </EuiPanel>
        </EuiFlexItem>
      </EuiFlexGroup>

      <ErrorCallouts errors={status.errors} />

      {flyout && !detailRepo && !detailThaw && (
        <EuiFlyout onClose={() => setFlyout(null)} size="l" ownFocus>
          <EuiFlyoutHeader hasBorder>
            <EuiTitle size="m">
              <h2>
                {flyout.title} ({flyout.items.length})
              </h2>
            </EuiTitle>
          </EuiFlyoutHeader>
          <EuiFlyoutBody>
            {flyout.kind === 'repo' && (
              <EuiBasicTable
                items={flyout.items}
                columns={repoColumns}
                rowProps={(item) => ({
                  onClick: () => setDetailRepo(item),
                  style: { cursor: 'pointer' },
                })}
                noItemsMessage="No repositories found"
              />
            )}
            {flyout.kind === 'thaw' && (
              <EuiBasicTable
                items={flyout.items}
                columns={thawColumns}
                rowProps={(item) => ({
                  onClick: () => setDetailThaw(item),
                  style: { cursor: 'pointer' },
                })}
                noItemsMessage="No thaw requests found"
              />
            )}
            {flyout.kind === 'ilm' && (
              <EuiBasicTable
                items={flyout.items}
                columns={ilmColumns}
                noItemsMessage="No ILM policies found"
              />
            )}
          </EuiFlyoutBody>
        </EuiFlyout>
      )}

      {detailRepo && (
        <EuiFlyout onClose={closeDetail} size="m" ownFocus>
          <EuiFlyoutHeader hasBorder>
            <EuiTitle size="m">
              <h2>{String(detailRepo.name || 'Repository details')}</h2>
            </EuiTitle>
          </EuiFlyoutHeader>
          <EuiFlyoutBody>
            <RecordList record={detailRepo} />
          </EuiFlyoutBody>
        </EuiFlyout>
      )}

      {detailThaw && (
        <EuiFlyout onClose={closeDetail} size="m" ownFocus>
          <EuiFlyoutHeader hasBorder>
            <EuiTitle size="m">
              <h2>
                Thaw request <code>{String(detailThaw.request_id || '').substring(0, 8)}</code>
              </h2>
            </EuiTitle>
          </EuiFlyoutHeader>
          <EuiFlyoutBody>
            <ThawDetailContent item={detailThaw} />
          </EuiFlyoutBody>
        </EuiFlyout>
      )}
    </>
  );
}

function RefreshHeader({
  loading,
  onRefresh,
}: {
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <EuiFlexGroup justifyContent="flexEnd" alignItems="center">
      <EuiFlexItem grow={false}>
        <RefreshControl onRefresh={onRefresh} loading={loading} />
      </EuiFlexItem>
    </EuiFlexGroup>
  );
}

function ErrorCallouts({ errors }: { errors: StatusResult['errors'] }) {
  if (!errors || errors.length === 0) return null;
  return (
    <>
      <EuiSpacer size="l" />
      {errors.map((err, i) => (
        <div key={i}>
          <EuiCallOut
            title={`[${err.code}] ${err.message}`}
            color={err.severity === 'error' ? 'danger' : 'warning'}
            iconType={err.severity === 'error' ? 'alert' : 'help'}
            size="s"
          />
          {i < errors.length - 1 && <EuiSpacer size="s" />}
        </div>
      ))}
    </>
  );
}

function RecordList({ record }: { record: object }) {
  return (
    <EuiDescriptionList
      type="column"
      compressed
      listItems={Object.entries(record)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([key, value]) => ({
          title: key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
          description:
            typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value),
        }))}
    />
  );
}

function ThawDetailContent({ item }: { item: ThawReq }) {
  const listItems = [
    { title: 'Request ID', description: String(item.request_id || '--') },
    { title: 'Status', description: String(item.status || '--') },
    { title: 'Created at', description: trimDate(item.created_at) || '--' },
    {
      title: 'Date range',
      description: `${trimDate(item.start_date) || '?'} → ${trimDate(item.end_date) || '?'}`,
    },
  ];

  return (
    <>
      <EuiDescriptionList type="column" compressed listItems={listItems} />
      {Array.isArray(item.repos) && item.repos.length > 0 && (
        <>
          <EuiSpacer size="l" />
          <EuiTitle size="xs">
            <h3>Repositories ({item.repos.length})</h3>
          </EuiTitle>
          <EuiSpacer size="s" />
          {item.repos.map((name, i) => (
            <div key={i} style={{ marginBottom: 8 }}>
              <EuiBadge color="hollow">{String(name)}</EuiBadge>
            </div>
          ))}
        </>
      )}
    </>
  );
}
