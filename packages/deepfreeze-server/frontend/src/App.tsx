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
  EuiFieldText,
  EuiFieldPassword,
  EuiButton,
  EuiForm,
  EuiFormRow,
  EuiCheckbox,
  EuiPanel,
  EuiCallOut,
  EuiFlexGroup,
  EuiFlexItem,
  EuiText,
} from '@elastic/eui';
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { api, login, logout, checkSession, onAuthError, getAuthToken } from './api/client';
import Overview from './pages/Overview';
import Activity from './pages/Activity';
import Scheduler from './pages/Scheduler';

type ColorMode = 'light' | 'dark';

function useColorMode(): [ColorMode, () => void] {
  const [colorMode, setColorMode] = useState<ColorMode>(() => {
    const saved = localStorage.getItem('deepfreeze-color-mode');
    return saved === 'light' ? 'light' : 'dark';
  });
  const toggle = useCallback(() => {
    setColorMode((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      localStorage.setItem('deepfreeze-color-mode', next);
      return next;
    });
  }, []);
  return [colorMode, toggle];
}

function LoginPage({ onToggleColorMode, onLogin }: {
  onToggleColorMode: () => void;
  onLogin: (username: string) => void;
}) {
  const [authMode, setAuthMode] = useState<'password' | 'apikey'>('password');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [remember, setRemember] = useState(true);

  const canSubmit = authMode === 'password'
    ? username && password
    : apiKey;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const credentials = authMode === 'password'
        ? { username, password }
        : { api_key: apiKey };
      const result = await login(credentials, remember);
      onLogin(result.username);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
      <div style={{ position: 'absolute', top: 16, right: 16 }}>
        <EuiButtonIcon
          iconType="invert"
          aria-label="Toggle light/dark mode"
          color="text"
          display="empty"
          size="s"
          onClick={onToggleColorMode}
        />
      </div>
      <EuiPanel paddingSize="xl" style={{ width: 400, maxWidth: '90vw' }}>
        <EuiFlexGroup alignItems="center" gutterSize="m" responsive={false}>
          <EuiFlexItem grow={false}>
            <EuiIcon type="snowflake" size="xl" color="primary" />
          </EuiFlexItem>
          <EuiFlexItem>
            <EuiTitle size="m">
              <h1>deepfreeze</h1>
            </EuiTitle>
          </EuiFlexItem>
        </EuiFlexGroup>

        <EuiSpacer size="s" />
        <EuiText size="s" color="subdued">
          <p>Sign in with your Elasticsearch credentials</p>
        </EuiText>

        <EuiSpacer size="l" />

        <EuiFlexGroup gutterSize="s">
          <EuiFlexItem>
            <EuiButton
              size="s"
              color={authMode === 'password' ? 'primary' : 'text'}
              fill={authMode === 'password'}
              onClick={() => setAuthMode('password')}
              fullWidth
            >
              Username / Password
            </EuiButton>
          </EuiFlexItem>
          <EuiFlexItem>
            <EuiButton
              size="s"
              color={authMode === 'apikey' ? 'primary' : 'text'}
              fill={authMode === 'apikey'}
              onClick={() => setAuthMode('apikey')}
              fullWidth
            >
              API Key
            </EuiButton>
          </EuiFlexItem>
        </EuiFlexGroup>

        <EuiSpacer size="l" />

        {error && (
          <>
            <EuiCallOut title={error} color="danger" iconType="alert" size="s" />
            <EuiSpacer size="m" />
          </>
        )}

        <form onSubmit={handleSubmit}>
          <EuiForm>
            {authMode === 'password' ? (
              <>
                <EuiFormRow label="Username">
                  <EuiFieldText
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoFocus
                  />
                </EuiFormRow>
                <EuiFormRow label="Password">
                  <EuiFieldPassword
                    type="dual"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </EuiFormRow>
              </>
            ) : (
              <EuiFormRow
                label="API Key"
                helpText="Encoded API key or id:key format — create one in Kibana under Stack Management > API Keys"
              >
                <EuiFieldPassword
                  type="dual"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  autoFocus
                />
              </EuiFormRow>
            )}
            <EuiSpacer size="s" />
            <EuiCheckbox
              id="deepfreeze-remember-me"
              label="Remember me on this device"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <EuiSpacer size="m" />
            <EuiButton
              type="submit"
              fill
              fullWidth
              isLoading={loading}
              isDisabled={!canSubmit}
            >
              Sign in
            </EuiButton>
          </EuiForm>
        </form>
      </EuiPanel>
    </div>
  );
}

function AppShell({ onToggleColorMode, username, onLogout }: {
  onToggleColorMode: () => void;
  username: string;
  onLogout: () => void;
}) {
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
          name: 'Scheduler',
          id: 'scheduler',
          icon: <EuiIcon type="calendar" />,
          isSelected: location.pathname === '/scheduler',
          onClick: () => navigate('/scheduler'),
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
            <EuiText size="xs" color="subdued" style={{ marginRight: 4 }}>
              {username}
            </EuiText>
          </EuiHeaderSectionItem>
          <EuiHeaderSectionItem>
            <EuiButtonIcon
              iconType="invert"
              aria-label="Toggle light/dark mode"
              color="text"
              display="empty"
              size="s"
              onClick={onToggleColorMode}
            />
          </EuiHeaderSectionItem>
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
          <EuiHeaderSectionItem>
            <EuiButtonIcon
              iconType="exit"
              aria-label="Sign out"
              color="text"
              display="empty"
              size="s"
              onClick={onLogout}
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
            <Route path="/scheduler" element={<Scheduler />} />
            <Route path="/activity" element={<Activity />} />
            {/* Consolidated onto Overview; redirect old paths */}
            <Route path="*" element={<Navigate to="/" replace />} />
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
  const [colorMode, toggleColorMode] = useColorMode();
  const [username, setUsername] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  // Check for existing session on mount
  useEffect(() => {
    if (getAuthToken()) {
      checkSession().then((info) => {
        if (info) setUsername(info.username);
        setAuthChecked(true);
      });
    } else {
      setAuthChecked(true);
    }
  }, []);

  // Listen for 401 errors to force re-login
  useEffect(() => {
    onAuthError(() => setUsername(null));
  }, []);

  const handleLogout = useCallback(async () => {
    await logout();
    setUsername(null);
  }, []);

  if (!authChecked) return null; // brief loading state

  return (
    <EuiProvider colorMode={colorMode}>
      {username ? (
        <BrowserRouter>
          <AppShell
            onToggleColorMode={toggleColorMode}
            username={username}
            onLogout={handleLogout}
          />
        </BrowserRouter>
      ) : (
        <LoginPage
          onToggleColorMode={toggleColorMode}
          onLogin={setUsername}
        />
      )}
    </EuiProvider>
  );
}
