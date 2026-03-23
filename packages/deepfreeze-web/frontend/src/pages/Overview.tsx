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
} from '@elastic/eui';
import { useStatus } from '../hooks/useStatus';
import RefreshControl from '../components/RefreshControl';

function clusterHealthColor(status: string): 'success' | 'warning' | 'danger' | 'subdued' {
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

export default function Overview() {
  const { status, loading, error, refresh } = useStatus();

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
      <EuiCallOut title="Error loading status" color="danger" iconType="alert">
        <p>{error}</p>
        <EuiButton color="danger" onClick={() => refresh(true)}>
          Retry
        </EuiButton>
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

  return (
    <>
      <EuiFlexGroup justifyContent="spaceBetween" alignItems="center">
        <EuiFlexItem grow={false}>
          <EuiTitle size="l">
            <h2>Overview</h2>
          </EuiTitle>
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
                <strong>Cluster: {status.cluster.name}</strong> &mdash; {status.cluster.status}
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

      {/* Stat Cards */}
      <EuiFlexGroup gutterSize="l" wrap>
        <EuiFlexItem>
          <EuiPanel hasBorder>
            <EuiStat
              title={repos.length}
              description="Total Repositories"
              titleColor="primary"
            />
          </EuiPanel>
        </EuiFlexItem>

        <EuiFlexItem>
          <EuiPanel hasBorder>
            <EuiStat
              title={stateCounts['active'] || 0}
              description="Active"
              titleColor="success"
            />
          </EuiPanel>
        </EuiFlexItem>

        <EuiFlexItem>
          <EuiPanel hasBorder>
            <EuiStat
              title={stateCounts['frozen'] || 0}
              description="Frozen"
              titleColor="primary"
            />
          </EuiPanel>
        </EuiFlexItem>

        <EuiFlexItem>
          <EuiPanel hasBorder>
            <EuiStat
              title={stateCounts['thawing'] || 0}
              description="Thawing"
              titleColor="accent"
            />
          </EuiPanel>
        </EuiFlexItem>

        <EuiFlexItem>
          <EuiPanel hasBorder>
            <EuiStat
              title={stateCounts['thawed'] || 0}
              description="Thawed"
              titleColor="secondary"
            />
          </EuiPanel>
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiSpacer size="l" />

      <EuiFlexGroup gutterSize="l" wrap>
        <EuiFlexItem>
          <EuiPanel hasBorder>
            <EuiStat
              title={status.thaw_requests.length}
              description="Thaw Requests"
              titleColor="accent"
            />
          </EuiPanel>
        </EuiFlexItem>

        <EuiFlexItem>
          <EuiPanel hasBorder>
            <EuiStat
              title={status.buckets.length}
              description="Buckets"
              titleColor="primary"
            />
          </EuiPanel>
        </EuiFlexItem>

        <EuiFlexItem>
          <EuiPanel hasBorder>
            <EuiStat
              title={status.ilm_policies.length}
              description="ILM Policies"
              titleColor="primary"
            />
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
    </>
  );
}
