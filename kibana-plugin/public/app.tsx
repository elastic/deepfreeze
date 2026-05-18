import React, { useEffect, useMemo } from 'react';
import { Redirect, useHistory, useLocation } from 'react-router-dom';
import { Routes, Route } from '@kbn/shared-ux-router';
import { EuiPageTemplate } from '@elastic/eui';
import type { CoreStart } from '@kbn/core/public';
import type { ManagementAppMountParams } from '@kbn/management-plugin/public';

import { OverviewPage } from './pages/overview';
import { RepositoriesPage } from './pages/repositories';
import { ThawRequestsPage } from './pages/thaw_requests';
import { ActivityPage } from './pages/activity';

interface AppProps {
  http: CoreStart['http'];
  notifications: CoreStart['notifications'];
  setBreadcrumbs: ManagementAppMountParams['setBreadcrumbs'];
}

interface TabDef {
  id: string;
  path: string;
  label: string;
}

const TABS: TabDef[] = [
  { id: 'overview', path: '/overview', label: 'Overview' },
  { id: 'repositories', path: '/repositories', label: 'Repositories' },
  { id: 'thaw_requests', path: '/thaw-requests', label: 'Thaw requests' },
  { id: 'activity', path: '/activity', label: 'Activity' },
];

export function App({ http, notifications, setBreadcrumbs }: AppProps) {
  const history = useHistory();
  const location = useLocation();

  const currentTab = useMemo(
    () => TABS.find((t) => location.pathname.startsWith(t.path)) ?? TABS[0],
    [location.pathname]
  );

  useEffect(() => {
    const crumbs = [
      {
        text: 'Deepfreeze',
        href: '/overview',
        onClick: (e: React.MouseEvent) => {
          e.preventDefault();
          history.push('/overview');
        },
      },
    ];
    if (currentTab.id !== 'overview') {
      crumbs.push({ text: currentTab.label } as (typeof crumbs)[number]);
    }
    setBreadcrumbs(crumbs);
  }, [currentTab, setBreadcrumbs, history]);

  const tabs = TABS.map((t) => ({
    label: t.label,
    isSelected: currentTab.id === t.id,
    onClick: () => history.push(t.path),
  }));

  return (
    <EuiPageTemplate restrictWidth={false}>
      <EuiPageTemplate.Header
        pageTitle="Deepfreeze"
        description="Long-term, offline storage for Elasticsearch data."
        tabs={tabs}
      />
      <EuiPageTemplate.Section>
        <Routes>
          <Route path="/overview">
            <OverviewPage http={http} notifications={notifications} />
          </Route>
          <Route path="/repositories">
            <RepositoriesPage http={http} notifications={notifications} />
          </Route>
          <Route path="/thaw-requests">
            <ThawRequestsPage http={http} notifications={notifications} />
          </Route>
          <Route path="/activity">
            <ActivityPage http={http} />
          </Route>
          <Redirect to="/overview" />
        </Routes>
      </EuiPageTemplate.Section>
    </EuiPageTemplate>
  );
}
