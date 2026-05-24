import React, { useMemo, useState } from 'react';
import {
  EuiBadge,
  EuiButton,
  EuiDescriptionList,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFlyout,
  EuiFlyoutBody,
  EuiFlyoutHeader,
  EuiHealth,
  EuiInMemoryTable,
  EuiSpacer,
  EuiText,
  EuiTitle,
  type EuiBasicTableColumn,
  type EuiSearchBarProps,
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

/**
 * Color a sampled storage tier so the table communicates state at a
 * glance. Archive = primary (long-term cold storage, the deepfreeze
 * happy path), Standard/Cool = success/warning (data still in fast
 * tiers), Mixed/Empty/Unknown/N/A = hollow (informational).
 */
function renderTierBadge(tier: string | undefined): JSX.Element {
  if (!tier) {
    return (
      <EuiText size="s" color="subdued">
        --
      </EuiText>
    );
  }
  let color: 'success' | 'warning' | 'primary' | 'hollow' = 'hollow';
  if (tier === 'Standard') color = 'success';
  else if (tier === 'Cool') color = 'warning';
  else if (tier === 'Archive') color = 'primary';
  return <EuiBadge color={color}>{tier}</EuiBadge>;
}

export function RepositoriesPage({ http, notifications }: RepositoriesPageProps) {
  const { status, loading, error, refresh } = useStatus(http);
  const [flyoutRepo, setFlyoutRepo] = useState<Repo | null>(null);
  const [repairOpen, setRepairOpen] = useState(false);

  const repos = useMemo<Repo[]>(() => status?.repositories ?? [], [status]);

  const stateOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const r of repos) {
      if (r.thaw_state) seen.add(r.thaw_state);
    }
    return [...seen].sort().map((value) => ({ value, name: value }));
  }, [repos]);

  const tierOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const r of repos) {
      if (r.storage_tier) seen.add(r.storage_tier);
    }
    return [...seen].sort().map((value) => ({ value, name: value }));
  }, [repos]);

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
      field: 'base_path',
      name: 'Path',
      sortable: true,
      truncateText: true,
      // Bucket is uniform across all repos in a deepfreeze install
      // (Setup pins one bucket), and `deepfreeze/` is the forced
      // prefix on every base_path — so we strip both and show just
      // the per-repo suffix (e.g. `snapshots-000001`).
      render: (_: unknown, item: Repo) =>
        (item.base_path || '').replace(/^deepfreeze\//, '') || '/',
    },
    {
      field: 'start',
      name: 'Date range',
      width: '210px',
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
      width: '90px',
      render: (mounted: boolean) => (
        <EuiBadge color={mounted ? 'success' : 'default'}>{mounted ? 'Yes' : 'No'}</EuiBadge>
      ),
    },
    {
      field: 'storage_tier',
      name: 'Tier',
      sortable: true,
      width: '110px',
      render: (tier: string | undefined) => renderTierBadge(tier),
    },
    {
      field: 'thaw_state',
      name: 'State',
      sortable: true,
      width: '110px',
      render: (state: string) => (
        <EuiHealth color={stateHealthColor(state || 'unknown')}>{state || 'unknown'}</EuiHealth>
      ),
    },
  ];

  const search: EuiSearchBarProps = {
    box: { incremental: true, schema: true, placeholder: 'Search repositories…' },
    toolsRight: [
      <EuiButton key="repair" iconType="wrench" onClick={() => setRepairOpen(true)}>
        Repair metadata
      </EuiButton>,
      <RefreshControl key="refresh" onRefresh={refresh} loading={loading} />,
    ],
    filters: [
      {
        type: 'field_value_selection',
        field: 'thaw_state',
        name: 'State',
        multiSelect: 'or',
        options: stateOptions,
      },
      {
        type: 'field_value_selection',
        field: 'storage_tier',
        name: 'Tier',
        multiSelect: 'or',
        options: tierOptions,
      },
      {
        type: 'field_value_toggle',
        field: 'is_mounted',
        value: true,
        name: 'Mounted',
      },
    ],
  };

  return (
    <>
      <EuiFlexGroup justifyContent="spaceBetween" alignItems="center">
        <EuiFlexItem grow={false}>
          <EuiTitle size="m">
            <h2>Repositories</h2>
          </EuiTitle>
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiSpacer size="m" />

      <EuiInMemoryTable
        items={repos}
        columns={columns}
        compressed
        responsiveBreakpoint={false}
        search={search}
        sorting={{ sort: { field: 'name', direction: 'asc' } }}
        pagination={{ pageSizeOptions: [10, 25, 50], initialPageSize: 25 }}
        loading={loading}
        rowProps={(item: Repo) => ({
          onClick: () => setFlyoutRepo(item),
          style: { cursor: 'pointer' },
        })}
        noItemsMessage="No repositories match the current filters."
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
