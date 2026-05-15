import React from 'react';
import ReactDOM from 'react-dom';
import { EuiPageTemplate, EuiText } from '@elastic/eui';
import { I18nProvider } from '@kbn/i18n-react';
import { KibanaContextProvider } from '@kbn/kibana-react-plugin/public';

import type { AppMountParameters, CoreStart } from '@kbn/core/public';
import type { DeepfreezePluginStartDeps } from './types';

/**
 * Phase 0 placeholder app — renders an empty page template so that the
 * plugin registers a mount-able app, but exposes no real UI yet.
 *
 * Phase 1 replaces the body of this function with a Router + page
 * components ported from packages/deepfreeze-server/frontend/.
 */
export function renderApp(
  coreStart: CoreStart,
  plugins: DeepfreezePluginStartDeps,
  { element }: AppMountParameters
) {
  ReactDOM.render(
    <KibanaContextProvider services={{ ...coreStart, ...plugins }}>
      <I18nProvider>
        <EuiPageTemplate restrictWidth={false}>
          <EuiPageTemplate.Header pageTitle="Deepfreeze" />
          <EuiPageTemplate.Section>
            <EuiText>
              <p>
                Deepfreeze plugin scaffolding is in place. Read-only views land in Phase 1.
              </p>
            </EuiText>
          </EuiPageTemplate.Section>
        </EuiPageTemplate>
      </I18nProvider>
    </KibanaContextProvider>,
    element
  );

  return () => {
    ReactDOM.unmountComponentAtNode(element);
  };
}
