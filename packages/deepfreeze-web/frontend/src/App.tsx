import { useState } from 'react';
import {
  EuiProvider,
  EuiPageTemplate,
  EuiSideNav,
  EuiHeader,
  EuiHeaderSection,
  EuiHeaderSectionItem,
  EuiTitle,
  EuiSpacer,
  EuiIcon,
} from '@elastic/eui';
import { BrowserRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import Overview from './pages/Overview';
import Repositories from './pages/Repositories';
import ThawRequests from './pages/ThawRequests';
import Actions from './pages/Actions';
import Activity from './pages/Activity';

function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const [isSideNavOpenOnMobile, setIsSideNavOpenOnMobile] = useState(false);

  const sideNavItems = [
    {
      name: 'deepfreeze',
      id: 'deepfreeze-nav',
      items: [
        {
          name: 'Overview',
          id: 'overview',
          icon: <EuiIcon type="dashboardApp" />,
          isSelected: location.pathname === '/',
          onClick: () => navigate('/'),
        },
        {
          name: 'Repositories',
          id: 'repositories',
          icon: <EuiIcon type="database" />,
          isSelected: location.pathname === '/repositories',
          onClick: () => navigate('/repositories'),
        },
        {
          name: 'Thaw Requests',
          id: 'thaw-requests',
          icon: <EuiIcon type="temperature" />,
          isSelected: location.pathname === '/thaw-requests',
          onClick: () => navigate('/thaw-requests'),
        },
        {
          name: 'Actions',
          id: 'actions',
          icon: <EuiIcon type="play" />,
          isSelected: location.pathname === '/actions',
          onClick: () => navigate('/actions'),
        },
        {
          name: 'Activity',
          id: 'activity',
          icon: <EuiIcon type="clock" />,
          isSelected: location.pathname === '/activity',
          onClick: () => navigate('/activity'),
        },
      ],
    },
  ];

  return (
    <>
      <EuiHeader
        position="fixed"
        sections={[
          {
            items: [
              <EuiHeaderSection key="title">
                <EuiHeaderSectionItem>
                  <EuiIcon type="snowflake" size="l" color="primary" />
                  <EuiTitle size="xs">
                    <h1 style={{ marginLeft: 8 }}>deepfreeze</h1>
                  </EuiTitle>
                </EuiHeaderSectionItem>
              </EuiHeaderSection>,
            ],
          },
        ]}
      />
      <EuiPageTemplate
        panelled
        restrictWidth={false}
        style={{ paddingTop: 48 }}
      >
        <EuiPageTemplate.Sidebar sticky>
          <EuiSpacer size="s" />
          <EuiSideNav
            mobileTitle="Navigation"
            toggleOpenOnMobile={() => setIsSideNavOpenOnMobile(!isSideNavOpenOnMobile)}
            isOpenOnMobile={isSideNavOpenOnMobile}
            items={sideNavItems}
          />
        </EuiPageTemplate.Sidebar>
        <EuiPageTemplate.Section>
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/repositories" element={<Repositories />} />
            <Route path="/thaw-requests" element={<ThawRequests />} />
            <Route path="/actions" element={<Actions />} />
            <Route path="/activity" element={<Activity />} />
          </Routes>
        </EuiPageTemplate.Section>
      </EuiPageTemplate>
    </>
  );
}

export default function App() {
  return (
    <EuiProvider colorMode="dark">
      <BrowserRouter>
        <AppShell />
      </BrowserRouter>
    </EuiProvider>
  );
}
