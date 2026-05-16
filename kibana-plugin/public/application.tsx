import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom';
import {
  EuiBasicTable,
  EuiCallOut,
  EuiFlexGrid,
  EuiFlexItem,
  EuiHealth,
  EuiLoadingSpinner,
  EuiPageTemplate,
  EuiPanel,
  EuiSpacer,
  EuiStat,
  EuiText,
  EuiTitle,
} from '@elastic/eui';
import { I18nProvider } from '@kbn/i18n-react';
import { KibanaContextProvider } from '@kbn/kibana-react-plugin/public';

import type { CoreStart } from '@kbn/core/public';
import type { ManagementAppMountParams } from '@kbn/management-plugin/public';

import { API } from '../common/api/paths';
import type { StatusResult } from '../server/actions/status';
import type { DeepfreezePluginStartDeps } from './types';

/**
 * Phase 1 Overview — minimal end-to-end verification that the plugin
 * can fetch from its own server route and render real data. The four
 * full pages (Overview / Repositories / Thaw Requests / Activity) will
 * replace this in subsequent work.
 */
export function renderApp(
  coreStart: CoreStart,
  plugins: DeepfreezePluginStartDeps,
  params: ManagementAppMountParams
) {
  params.setBreadcrumbs([{ text: 'Deepfreeze' }]);

  ReactDOM.render(
    <KibanaContextProvider services={{ ...coreStart, ...plugins }}>
      <I18nProvider>
        <Overview http={coreStart.http} />
      </I18nProvider>
    </KibanaContextProvider>,
    params.element
  );

  return () => {
    ReactDOM.unmountComponentAtNode(params.element);
  };
}

interface OverviewProps {
  http: CoreStart['http'];
}

function Overview({ http }: OverviewProps) {
  const [status, setStatus] = useState<StatusResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    http
      .get<StatusResult>(API.status)
      .then((result) => {
        if (!cancelled) {
          setStatus(result);
          setError(null);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message || 'Failed to load status');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [http]);

  return (
    <EuiPageTemplate restrictWidth={false}>
      <EuiPageTemplate.Header pageTitle="Deepfreeze" description="Cold-storage lifecycle for Elasticsearch snapshots." />
      <EuiPageTemplate.Section>
        {loading && <EuiLoadingSpinner size="xl" />}
        {error && (
          <EuiCallOut title="Failed to load status" color="danger" iconType="error">
            <p>{error}</p>
          </EuiCallOut>
        )}
        {status && !status.initialized && (
          <EuiCallOut
            title="Deepfreeze is not initialized in this cluster"
            color="warning"
            iconType="warning"
          >
            <p>
              {status.errors[0]?.message ?? 'Run Setup to initialize.'}{' '}
              Setup from the UI will be available in Phase 2.
            </p>
          </EuiCallOut>
        )}
        {status && status.initialized && <InitializedView status={status} />}
      </EuiPageTemplate.Section>
    </EuiPageTemplate>
  );
}

function InitializedView({ status }: { status: StatusResult }) {
  const inProgressThaws = status.thaw_requests.filter((r) => r.status === 'in_progress').length;

  return (
    <>
      <EuiFlexGrid columns={4} gutterSize="m">
        <EuiFlexItem>
          <EuiPanel paddingSize="m">
            <EuiStat
              title={
                <EuiHealth
                  color={
                    status.cluster.status === 'green'
                      ? 'success'
                      : status.cluster.status === 'yellow'
                      ? 'warning'
                      : 'danger'
                  }
                  textSize="m"
                >
                  {status.cluster.status}
                </EuiHealth>
              }
              description={`Cluster ${status.cluster.name || ''}`}
              titleSize="s"
            />
          </EuiPanel>
        </EuiFlexItem>
        <EuiFlexItem>
          <EuiPanel paddingSize="m">
            <EuiStat title={String(status.repositories.length)} description="Repositories" titleSize="s" />
          </EuiPanel>
        </EuiFlexItem>
        <EuiFlexItem>
          <EuiPanel paddingSize="m">
            <EuiStat title={String(inProgressThaws)} description="Active thaws" titleSize="s" />
          </EuiPanel>
        </EuiFlexItem>
        <EuiFlexItem>
          <EuiPanel paddingSize="m">
            <EuiStat title={String(status.ilm_policies.length)} description="ILM policies" titleSize="s" />
          </EuiPanel>
        </EuiFlexItem>
      </EuiFlexGrid>

      <EuiSpacer size="l" />

      <EuiTitle size="s">
        <h2>Repositories</h2>
      </EuiTitle>
      <EuiSpacer size="s" />
      {status.repositories.length === 0 ? (
        <EuiText color="subdued">
          <p>No repositories yet. Run Rotate to create the first one.</p>
        </EuiText>
      ) : (
        <EuiBasicTable
          items={status.repositories}
          rowHeader="name"
          columns={[
            { field: 'name', name: 'Name' },
            { field: 'bucket', name: 'Bucket' },
            { field: 'base_path', name: 'Base path' },
            { field: 'thaw_state', name: 'State' },
            {
              field: 'is_mounted',
              name: 'Mounted',
              render: (mounted: boolean) =>
                mounted ? <EuiHealth color="success">Yes</EuiHealth> : <EuiHealth color="subdued">No</EuiHealth>,
            },
          ]}
        />
      )}
    </>
  );
}
