import React, { useMemo, useState } from 'react';
import {
  EuiBadge,
  EuiBasicTable,
  EuiButton,
  EuiCallOut,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFlyout,
  EuiFlyoutBody,
  EuiFlyoutHeader,
  EuiHealth,
  EuiLink,
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
import { RotateModal } from '../components/rotate_modal';
import { CleanupModal } from '../components/cleanup_modal';
import { RefreezeModal } from '../components/refreeze_modal';
import {
  formatRemaining,
  formatStoredDatetime,
  formatTimestamp,
} from '../utils/format';
import { SetupWizard } from './setup_wizard';
import type { StatusResult } from '../../server/actions/status';

interface OverviewPageProps {
  http: CoreStart['http'];
  notifications: CoreStart['notifications'];
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
    field: 'base_path',
    name: 'Path',
    truncateText: true,
    render: (_: unknown, item: Repo) =>
      (item.base_path || '').replace(/^deepfreeze\//, '') || '/',
  },
  {
    field: 'start',
    name: 'Date range',
    render: (_: unknown, item: Repo) => {
      const start = formatStoredDatetime(item.start);
      const end = formatStoredDatetime(item.end);
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
    field: 'storage_tier',
    name: 'Tier',
    render: (tier: string | undefined) => {
      if (!tier) return '--';
      let color: 'success' | 'warning' | 'primary' | 'hollow' = 'hollow';
      if (tier === 'Standard') color = 'success';
      else if (tier === 'Cool') color = 'warning';
      else if (tier === 'Archive') color = 'primary';
      return <EuiBadge color={color}>{tier}</EuiBadge>;
    },
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
    name: 'Date range (UTC)',
    render: (_: unknown, item: ThawReq) => {
      const start = formatStoredDatetime(item.start_date);
      const end = formatStoredDatetime(item.end_date);
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
    render: (ts: string) => (ts ? formatTimestamp(ts) : '--'),
  },
];

function buildIlmColumns(
  http: CoreStart['http']
): Array<EuiBasicTableColumn<IlmPolicy>> {
  return [
    {
      field: 'name',
      name: 'Policy name',
      sortable: true,
      render: (name: string) => (
        <EuiLink
          href={http.basePath.prepend(
            `/app/management/data/index_lifecycle_management/policies/edit/${encodeURIComponent(
              name
            )}`
          )}
          // Open in the same tab; Kibana's router handles the cross-app
          // navigation. EuiLink renders an <a href>, so Cmd/Ctrl-click
          // still works for "open in new tab".
        >
          <strong>{name}</strong>
        </EuiLink>
      ),
    },
    { field: 'repository', name: 'Repository', sortable: true },
    { field: 'indices_count', name: 'Indices', sortable: true },
    { field: 'data_streams_count', name: 'Data streams', sortable: true },
    { field: 'templates_count', name: 'Templates', sortable: true },
  ];
}

type FlyoutState =
  | { kind: 'repo'; title: string; items: Repo[] }
  | { kind: 'thaw'; title: string; items: ThawReq[] }
  | { kind: 'ilm'; title: string; items: IlmPolicy[] };

export function OverviewPage({ http, notifications }: OverviewPageProps) {
  const { status, loading, error, refresh } = useStatus(http);
  const [flyout, setFlyout] = useState<FlyoutState | null>(null);
  const [detailRepo, setDetailRepo] = useState<Repo | null>(null);
  const [detailThaw, setDetailThaw] = useState<ThawReq | null>(null);
  const [refreezeTarget, setRefreezeTarget] = useState<ThawReq | null>(null);
  const [activeAction, setActiveAction] = useState<'rotate' | 'cleanup' | null>(null);
  const ilmColumns = useMemo(() => buildIlmColumns(http), [http]);

  if (loading && !status) return <PageLoading />;
  if (error && !status) return <PageError message={error} onRetry={refresh} />;
  if (!status) return null;

  const cardStyle: React.CSSProperties = { cursor: 'pointer' };

  if (!status.initialized) {
    // MISSING_INDEX and MISSING_SETTINGS are the by-design uninitialized signal
    // that drove us into this branch — the wizard is the answer to them, so
    // hide them. Anything else (e.g. cluster-health fetch failure) still
    // surfaces.
    const unrelatedErrors = status.errors.filter(
      (e) => e.code !== 'MISSING_INDEX' && e.code !== 'MISSING_SETTINGS'
    );
    return (
      <>
        <SetupWizard http={http} onComplete={refresh} />
        <ErrorCallouts errors={unrelatedErrors} />
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
      <EuiFlexGroup justifyContent="spaceBetween" alignItems="center">
        <EuiFlexItem grow={false}>
          <EuiFlexGroup gutterSize="s" alignItems="center">
            <EuiFlexItem grow={false}>
              <EuiButton iconType="refresh" onClick={() => setActiveAction('rotate')} size="s">
                Rotate
              </EuiButton>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiButton iconType="trash" onClick={() => setActiveAction('cleanup')} size="s">
                Cleanup
              </EuiButton>
            </EuiFlexItem>
          </EuiFlexGroup>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <RefreshControl onRefresh={refresh} loading={loading} />
        </EuiFlexItem>
      </EuiFlexGroup>

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
                compressed
                responsiveBreakpoint={false}
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
                compressed
                responsiveBreakpoint={false}
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
                compressed
                responsiveBreakpoint={false}
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
            <ThawDetailContent
              item={detailThaw}
              repos={status.repositories ?? []}
            />
            {detailThaw.status === 'completed' && (
              <>
                <EuiSpacer size="l" />
                <EuiButton
                  color="danger"
                  iconType="snowflake"
                  onClick={() => {
                    setRefreezeTarget(detailThaw);
                    setDetailThaw(null);
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

      {activeAction === 'rotate' && (
        <RotateModal
          http={http}
          notifications={notifications}
          onClose={() => setActiveAction(null)}
          onComplete={refresh}
        />
      )}
      {activeAction === 'cleanup' && (
        <CleanupModal
          http={http}
          notifications={notifications}
          onClose={() => setActiveAction(null)}
          onComplete={refresh}
        />
      )}
    </>
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

interface FieldRow {
  field: string;
  value: string;
}

const FIELD_VALUE_COLUMNS: Array<EuiBasicTableColumn<FieldRow>> = [
  { field: 'field', name: 'Field', width: '200px' },
  {
    field: 'value',
    name: 'Value',
    render: (v: string) => (
      <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{v}</span>
    ),
  },
];

/**
 * Render a record's fields as a two-column (Field | Value) table.
 *
 * For repository records, two fields get extra treatment so they stay
 * scannable when many repos share the same bucket and `deepfreeze/`
 * prefix: `bucket` is hidden (it's uniform across an install), and
 * `base_path` is shown without its forced `deepfreeze/` prefix.
 */
function RecordList({ record }: { record: object }) {
  const items: FieldRow[] = Object.entries(record)
    .filter(([key, v]) => v !== null && v !== undefined && key !== 'bucket')
    .map(([key, value]) => {
      let displayValue: string;
      if (key === 'base_path' && typeof value === 'string') {
        displayValue = value.replace(/^deepfreeze\//, '') || '/';
      } else if (typeof value === 'object') {
        displayValue = JSON.stringify(value, null, 2);
      } else {
        displayValue = String(value);
      }
      return {
        field: key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        value: displayValue,
      };
    });
  return (
    <EuiBasicTable
      items={items}
      columns={FIELD_VALUE_COLUMNS}
      compressed
      responsiveBreakpoint={false}
      itemId="field"
    />
  );
}

function ThawDetailContent({
  item,
  repos,
}: {
  item: ThawReq;
  repos: Repo[];
}) {
  const items: FieldRow[] = [
    { field: 'Request ID', value: String(item.request_id || '--') },
    { field: 'Status', value: String(item.status || '--') },
    { field: 'Created at', value: formatTimestamp(item.created_at) || '--' },
    {
      field: 'Date range (UTC)',
      value: `${formatStoredDatetime(item.start_date) || '?'} → ${formatStoredDatetime(item.end_date) || '?'}`,
    },
  ];

  // For completed requests, surface when the temporary S3 restore copy
  // expires — at that point the data goes back to Glacier and queries
  // against the mounted indices stop working. We use the earliest
  // expires_at across all of this request's repos.
  if (item.status === 'completed') {
    const lookup = new Map(repos.map((r) => [r.name, r]));
    const expiries: string[] = [];
    for (const name of item.repos ?? []) {
      const repo = lookup.get(String(name));
      if (repo?.expires_at) expiries.push(repo.expires_at);
    }
    if (expiries.length > 0) {
      const earliest = expiries.reduce((a, b) =>
        new Date(a).getTime() <= new Date(b).getTime() ? a : b
      );
      const remaining = formatRemaining(earliest);
      items.push({
        field:
          item.repos.length > 1
            ? 'Returns to Glacier (earliest)'
            : 'Returns to Glacier',
        value: remaining
          ? `${formatStoredDatetime(earliest)} (${remaining})`
          : formatStoredDatetime(earliest),
      });
    }
  }

  return (
    <>
      <EuiBasicTable
        items={items}
        columns={FIELD_VALUE_COLUMNS}
        compressed
        responsiveBreakpoint={false}
        itemId="field"
      />
      {Array.isArray(item.repos) && item.repos.length > 0 && (
        <>
          <EuiSpacer size="l" />
          <EuiTitle size="xs">
            <h3>Repositories ({item.repos.length})</h3>
          </EuiTitle>
          <EuiSpacer size="s" />
          {item.repos.map((name, i) => {
            const repo = repos.find((r) => r.name === String(name));
            const remaining = formatRemaining(repo?.expires_at);
            return (
              <div
                key={i}
                style={{
                  marginBottom: 8,
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                }}
              >
                <EuiBadge color="hollow">{String(name)}</EuiBadge>
                {remaining && (
                  <EuiText size="xs" color="subdued">
                    returns to Glacier {remaining}
                  </EuiText>
                )}
              </div>
            );
          })}
        </>
      )}
    </>
  );
}
