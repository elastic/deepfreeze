import { useState, useEffect, useCallback } from 'react';
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
  EuiButtonIcon,
  EuiFlyout,
  EuiFlyoutHeader,
  EuiFlyoutBody,
  EuiDescriptionList,
} from '@elastic/eui';
import { BrowserRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import { api } from './api/client';
import Overview from './pages/Overview';
import Repositories from './pages/Repositories';
import ThawRequests from './pages/ThawRequests';
import Actions from './pages/Actions';
import Activity from './pages/Activity';

function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const [isSideNavOpenOnMobile, setIsSideNavOpenOnMobile] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);

  const fetchConfig = useCallback(async () => {
    try {
      const data = await api.getStatus(false);
      setConfig(data.settings);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const configItems = config
    ? [
        { title: 'Provider', description: String(config.provider || '--') },
        { title: 'Repository Prefix', description: String(config.repo_name_prefix || '--') },
        { title: 'Bucket Prefix', description: String(config.bucket_name_prefix || '--') },
        { title: 'Base Path Prefix', description: String(config.base_path_prefix || '--') },
        { title: 'Storage Class', description: String(config.storage_class || '--') },
        { title: 'Canned ACL', description: String(config.canned_acl || '--') },
        { title: 'Rotation Style', description: String(config.style || '--') },
        { title: 'Rotate By', description: String(config.rotate_by || '--') },
        { title: 'Last Suffix', description: String(config.last_suffix || '--') },
        ...(config.ilm_policy_name
          ? [{ title: 'ILM Policy', description: String(config.ilm_policy_name) }]
          : []),
        ...(config.index_template_name
          ? [{ title: 'Index Template', description: String(config.index_template_name) }]
          : []),
        { title: 'Thaw Retention (completed)', description: `${config.thaw_request_retention_days_completed ?? 7} days` },
        { title: 'Thaw Retention (failed)', description: `${config.thaw_request_retention_days_failed ?? 30} days` },
        { title: 'Thaw Retention (refrozen)', description: `${config.thaw_request_retention_days_refrozen ?? 35} days` },
      ]
    : [];

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
      <EuiHeader position="fixed">
        <EuiHeaderSection>
          <EuiHeaderSectionItem>
            <EuiIcon type="snowflake" size="l" color="primary" />
            <EuiTitle size="xs">
              <h1 style={{ marginLeft: 8 }}>deepfreeze</h1>
            </EuiTitle>
          </EuiHeaderSectionItem>
        </EuiHeaderSection>
        <EuiHeaderSection side="right">
          <EuiHeaderSectionItem>
            <EuiButtonIcon
              iconType="gear"
              aria-label="Configuration"
              color="text"
              display="empty"
              size="s"
              onClick={() => {
                fetchConfig();
                setConfigOpen(true);
              }}
            />
          </EuiHeaderSectionItem>
        </EuiHeaderSection>
      </EuiHeader>
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

      {configOpen && (
        <EuiFlyout onClose={() => setConfigOpen(false)} size="s" ownFocus>
          <EuiFlyoutHeader hasBorder>
            <EuiTitle size="m">
              <h2>Configuration</h2>
            </EuiTitle>
          </EuiFlyoutHeader>
          <EuiFlyoutBody>
            {config ? (
              <EuiDescriptionList
                type="column"
                compressed
                listItems={configItems}
              />
            ) : (
              <p>No configuration loaded.</p>
            )}
          </EuiFlyoutBody>
        </EuiFlyout>
      )}
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
