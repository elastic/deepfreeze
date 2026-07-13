import { useState, useCallback, useEffect, type MouseEvent } from 'react';
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
  EuiButtonIcon,
  EuiConfirmModal,
  EuiGlobalToastList,
  EuiDescriptionList,
  EuiProgress,
  type EuiBasicTableColumn,
} from '@elastic/eui';
import { useStatus } from '../hooks/useStatus';
import { api, type RestoreProgress, type CommandResult } from '../api/client';
import RefreshControl from '../components/RefreshControl';
import Actions from '../components/Actions';
import ColumnsDescriptionList from '../components/ColumnsDescriptionList';
import SetupWizard from './SetupWizard';

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

// -- Column definitions for the list flyout --

const repoColumns: EuiBasicTableColumn<Repo>[] = [
  { field: 'name', name: 'Name', sortable: true, render: (v: string) => <strong>{v}</strong> },
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
  { field: 'is_mounted', name: 'Mounted', render: (v: unknown) => <EuiBadge color={v ? 'success' : 'default'}>{v ? 'Yes' : 'No'}</EuiBadge> },
  { field: 'thaw_state', name: 'State', sortable: true, render: (v: string) => <EuiBadge color={stateColor(v || 'unknown')}>{v || 'unknown'}</EuiBadge> },
  { field: 'storage_tier', name: 'Storage Tier', sortable: true, render: (v: string) => v || '--' },
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

// -- Flyout config types --

interface FlyoutConfig {
  title: string;
  items: Record<string, unknown>[];
  columns: EuiBasicTableColumn<Record<string, unknown>>[];
  kind: 'repo' | 'thaw' | 'bucket' | 'ilm';
}

interface Toast {
  id: string;
  title: string;
  color: 'success' | 'danger';
  text?: string;
}

// -- Thaw detail helpers (same as ThawRequests page) --

function formatElapsed(createdAt: string): string {
  try {
    const created = new Date(createdAt);
    const now = new Date();
    const totalSec = Math.max(0, Math.floor((now.getTime() - created.getTime()) / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  } catch {
    return '';
  }
}

function formatCountdown(expiresAt: string): { text: string; expired: boolean } {
  try {
    const expires = new Date(expiresAt);
    const now = new Date();
    const remainingSec = Math.floor((expires.getTime() - now.getTime()) / 1000);
    if (remainingSec <= 0) return { text: 'expired', expired: true };
    const days = Math.floor(remainingSec / 86400);
    const hours = Math.floor((remainingSec % 86400) / 3600);
    const minutes = Math.floor((remainingSec % 3600) / 60);
    const seconds = remainingSec % 60;
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (days > 0 || hours > 0) parts.push(`${hours}h`);
    parts.push(`${minutes}m`);
    if (days === 0) parts.push(`${seconds}s`);
    return { text: parts.join(' '), expired: false };
  } catch {
    return { text: '', expired: false };
  }
}

function ThawDetailContent({ item }: { item: ThawReq }) {
  const [elapsed, setElapsed] = useState('');
  const [countdown, setCountdown] = useState<{ text: string; expired: boolean }>({ text: '', expired: false });
  const createdAt = String(item.created_at || '');
  const expiresAt = String(item.expires_at || '');

  useEffect(() => {
    if (!createdAt) return;
    setElapsed(formatElapsed(createdAt));
    const timer = setInterval(() => setElapsed(formatElapsed(createdAt)), 1000);
    return () => clearInterval(timer);
  }, [createdAt]);

  useEffect(() => {
    if (!expiresAt) return;
    setCountdown(formatCountdown(expiresAt));
    const timer = setInterval(() => setCountdown(formatCountdown(expiresAt)), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  const statusStr = String(item.status || 'unknown');
  const listItems = [
    { title: 'Request ID', description: String(item.request_id || item.id || '--') },
    {
      title: 'Status',
      description: <EuiBadge color={thawStatusColor(statusStr)}>{statusStr}</EuiBadge>,
    },
    { title: 'Created At', description: createdAt ? `${trimDate(createdAt)}  (${elapsed} ago)` : '--' },
    { title: 'Date Range', description: `${trimDate(item.start_date) || '?'} \u2192 ${trimDate(item.end_date) || '?'}` },
  ];

  if (expiresAt) {
    listItems.push({
      title: 'Expires At',
      description: (
        <span>
          {trimDate(expiresAt)}{'  '}
          <EuiBadge color={countdown.expired ? 'danger' : 'warning'}>
            {countdown.expired ? 'expired' : `${countdown.text} left`}
          </EuiBadge>
        </span>
      ),
    });
  }

  return <EuiDescriptionList type="column" compressed listItems={listItems} />;
}

export default function Overview() {
  const { status, loading, error, refresh } = useStatus();
  const [flyout, setFlyout] = useState<FlyoutConfig | null>(null);

  // Detail-level state (second flyout layer)
  const [detailRepo, setDetailRepo] = useState<Repo | null>(null);
  const [detailThaw, setDetailThaw] = useState<ThawReq | null>(null);
  const [restoreProgress, setRestoreProgress] = useState<RestoreProgress[] | null>(null);
  const [progressLoading, setProgressLoading] = useState(false);

  // Refreeze action state (ported from the former Thaw Requests page)
  const [refreezeTarget, setRefreezeTarget] = useState<ThawReq | null>(null);
  const [refreezing, setRefreezing] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((title: string, color: 'success' | 'danger', text?: string) => {
    const id = String(Date.now());
    setToasts((prev) => [...prev, { id, title, color, text }]);
  }, []);

  const removeToast = useCallback((removedToast: { id: string }) => {
    setToasts((prev) => prev.filter((x) => x.id !== removedToast.id));
  }, []);

  const handleRefreeze = async () => {
    if (!refreezeTarget) return;
    const reqId = String(refreezeTarget.request_id || refreezeTarget.id || '');
    setRefreezing(true);
    try {
      const result: CommandResult = await api.refreeze({ request_id: reqId });
      if (result.success) {
        addToast('Refreeze completed', 'success', result.summary || `Request ${reqId.substring(0, 8)} refrozen.`);
        refresh(true);
      } else {
        addToast('Refreeze failed', 'danger', result.summary || 'Check errors for details.');
      }
    } catch (err) {
      addToast('Refreeze error', 'danger', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setRefreezing(false);
      setRefreezeTarget(null);
    }
  };

  const openThawDetail = useCallback((item: ThawReq) => {
    setDetailThaw(item);
    setRestoreProgress(null);
    if (item.status === 'in_progress') {
      const reqId = String(item.request_id || item.id || '');
      if (reqId) {
        setProgressLoading(true);
        api.getRestoreProgress(reqId)
          .then((data) => setRestoreProgress(data.repos))
          .catch(() => setRestoreProgress(null))
          .finally(() => setProgressLoading(false));
      }
    }
  }, []);

  // Auto-refresh restore progress while thaw detail flyout is open
  useEffect(() => {
    if (!detailThaw || detailThaw.status !== 'in_progress') return;
    const reqId = String(detailThaw.request_id || detailThaw.id || '');
    if (!reqId) return;

    const interval = setInterval(() => {
      api.getRestoreProgress(reqId)
        .then((data) => setRestoreProgress(data.repos))
        .catch(() => {});
    }, 15000);

    return () => clearInterval(interval);
  }, [detailThaw]);

  const closeDetail = () => {
    setDetailRepo(null);
    setDetailThaw(null);
    setRestoreProgress(null);
  };

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

  // Not yet initialized: gate the Overview behind the setup wizard. Once setup
  // completes, refresh status so the real Overview takes over.
  if (!status.initialized) {
    return <SetupWizard onComplete={() => refresh(true)} />;
  }

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
    setFlyout({ title, items: reposByState(state), columns: repoColumns, kind: 'repo' });
  };

  const cardStyle = { cursor: 'pointer' };

  // Row click handler for the list flyout table
  const getRowProps = (item: Record<string, unknown>) => {
    if (!flyout) return {};
    if (flyout.kind === 'repo') {
      return { onClick: () => setDetailRepo(item), style: { cursor: 'pointer' } };
    }
    if (flyout.kind === 'thaw') {
      return { onClick: () => openThawDetail(item), style: { cursor: 'pointer' } };
    }
    return {};
  };

  // Thaw list-flyout columns, with a Refreeze action for completed requests
  // (matches the clickable Actions column the old Thaw Requests table had).
  const thawColumnsWithActions: EuiBasicTableColumn<Record<string, unknown>>[] = [
    ...(thawColumns as EuiBasicTableColumn<Record<string, unknown>>[]),
    {
      name: 'Actions',
      width: '80px',
      render: (item: Record<string, unknown>) =>
        item.status === 'completed' ? (
          <EuiButtonIcon
            iconType="snowflake"
            color="danger"
            aria-label="Refreeze this thaw request"
            title="Refreeze"
            onClick={(e: MouseEvent) => {
              e.stopPropagation();
              setRefreezeTarget(item);
            }}
          />
        ) : null,
    },
  ];

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
            onClick={() => setFlyout({ title: 'Thaw Requests', items: status.thaw_requests, columns: thawColumnsWithActions, kind: 'thaw' })}
          >
            <EuiStat title={status.thaw_requests.length} description="Thaw Requests" titleColor="accent" />
          </EuiPanel>
        </EuiFlexItem>
        <EuiFlexItem>
          <EuiPanel
            hasBorder
            style={cardStyle}
            onClick={() => setFlyout({ title: 'Buckets', items: status.buckets, columns: bucketColumns, kind: 'bucket' })}
          >
            <EuiStat title={status.buckets.length} description="Buckets" titleColor="primary" />
          </EuiPanel>
        </EuiFlexItem>
        <EuiFlexItem>
          <EuiPanel
            hasBorder
            style={cardStyle}
            onClick={() => setFlyout({ title: 'ILM Policies', items: status.ilm_policies, columns: ilmColumns, kind: 'ilm' })}
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

      {/* Actions (consolidated from the former standalone Actions page) */}
      <EuiSpacer size="xl" />
      <Actions />

      {/* List flyout (first level) */}
      {flyout && !detailRepo && !detailThaw && (
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
              rowProps={getRowProps}
              noItemsMessage={`No ${flyout.title.toLowerCase()} found`}
            />
          </EuiFlyoutBody>
        </EuiFlyout>
      )}

      {/* Repository detail flyout (second level) */}
      {detailRepo && (
        <EuiFlyout onClose={closeDetail} size="m" ownFocus>
          <EuiFlyoutHeader hasBorder>
            <EuiTitle size="m">
              <h2>{String(detailRepo.name || 'Repository Details')}</h2>
            </EuiTitle>
          </EuiFlyoutHeader>
          <EuiFlyoutBody>
            {/* Same formatted cells as the Repositories list */}
            <ColumnsDescriptionList columns={repoColumns} item={detailRepo} />

            {/* Remaining fields not surfaced by a list column */}
            {(() => {
              const shownFields = new Set(
                repoColumns
                  .filter((c) => 'field' in c)
                  .map((c) => (c as { field: string }).field),
              );
              // 'start'/'end' are rendered together as the Date Range column.
              shownFields.add('start');
              shownFields.add('end');
              const extra = Object.entries(detailRepo).filter(
                ([key, v]) => v !== null && v !== undefined && !shownFields.has(key),
              );
              if (extra.length === 0) return null;
              return (
                <>
                  <EuiSpacer size="l" />
                  <EuiTitle size="xs"><h3>Additional Details</h3></EuiTitle>
                  <EuiSpacer size="s" />
                  <EuiDescriptionList
                    type="column"
                    compressed
                    listItems={extra.map(([key, value]) => ({
                      title: key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
                      description:
                        typeof value === 'object'
                          ? JSON.stringify(value, null, 2)
                          : String(value),
                    }))}
                  />
                </>
              );
            })()}
          </EuiFlyoutBody>
        </EuiFlyout>
      )}

      {/* Thaw request detail flyout (second level) */}
      {detailThaw && (
        <EuiFlyout onClose={closeDetail} size="m" ownFocus>
          <EuiFlyoutHeader hasBorder>
            <EuiTitle size="m">
              <h2>
                Thaw Request{' '}
                <code>{String(detailThaw.request_id || '').substring(0, 8)}</code>
              </h2>
            </EuiTitle>
          </EuiFlyoutHeader>
          <EuiFlyoutBody>
            <ThawDetailContent item={detailThaw} />

            {detailThaw.status === 'completed' && (
              <>
                <EuiSpacer size="m" />
                <EuiButton
                  iconType="snowflake"
                  color="danger"
                  onClick={() => setRefreezeTarget(detailThaw)}
                >
                  Refreeze
                </EuiButton>
              </>
            )}

            {Array.isArray(detailThaw.repositories) && detailThaw.repositories.length > 0 && (
              <>
                <EuiSpacer size="l" />
                <EuiTitle size="xs">
                  <h3>Repositories ({(detailThaw.repositories as unknown[]).length})</h3>
                </EuiTitle>
                <EuiSpacer size="s" />
                {(detailThaw.repositories as Record<string, unknown>[]).map((repo, i) => (
                  <div key={i} style={{ marginBottom: 8 }}>
                    <EuiBadge color="hollow">
                      {String(repo.name || repo.repository || repo)}
                    </EuiBadge>
                  </div>
                ))}
              </>
            )}

            {detailThaw.status === 'in_progress' && (
              <>
                <EuiSpacer size="l" />
                <EuiTitle size="xs">
                  <h3>S3 Restore Progress</h3>
                </EuiTitle>
                <EuiSpacer size="s" />
                {progressLoading && <EuiLoadingSpinner size="m" />}
                {restoreProgress && restoreProgress.map((rp, i) => {
                  const pct = rp.total > 0 ? Math.round((rp.restored / rp.total) * 100) : 0;
                  return (
                    <div key={i} style={{ marginBottom: 16 }}>
                      <EuiText size="s"><strong>{rp.repo}</strong></EuiText>
                      <EuiSpacer size="xs" />
                      <EuiProgress value={rp.restored} max={rp.total} size="m" color={rp.complete ? 'success' : 'primary'} />
                      <EuiSpacer size="xs" />
                      <EuiText size="xs" color="subdued">
                        {rp.restored}/{rp.total} restored ({pct}%)
                        {rp.in_progress > 0 && ` \u00b7 ${rp.in_progress} in progress`}
                        {rp.not_restored > 0 && ` \u00b7 ${rp.not_restored} pending`}
                        {rp.complete && ' \u00b7 Complete'}
                      </EuiText>
                    </div>
                  );
                })}
                {!progressLoading && !restoreProgress && (
                  <EuiText size="s" color="subdued">Could not load restore progress.</EuiText>
                )}
              </>
            )}
          </EuiFlyoutBody>
        </EuiFlyout>
      )}

      {/* Refreeze confirmation (ported from the former Thaw Requests page) */}
      {refreezeTarget && (
        <EuiConfirmModal
          title="Refreeze thaw request?"
          onCancel={() => setRefreezeTarget(null)}
          onConfirm={handleRefreeze}
          cancelButtonText="Cancel"
          confirmButtonText={refreezing ? 'Refreezing...' : 'Refreeze'}
          buttonColor="danger"
          isLoading={refreezing}
        >
          <EuiText size="s">
            <p>
              This will refreeze thaw request{' '}
              <code>{String(refreezeTarget.request_id || refreezeTarget.id || '').substring(0, 8)}</code>,
              unmount its snapshots, and mark the request as complete.
            </p>
          </EuiText>
        </EuiConfirmModal>
      )}

      <EuiGlobalToastList
        toasts={toasts}
        dismissToast={removeToast as (toast: { id: string }) => void}
        toastLifeTimeMs={8000}
      />
    </>
  );
}
