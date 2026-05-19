import React from 'react';
import ReactDOM from 'react-dom';
import { Router } from '@kbn/shared-ux-router';
import { I18nProvider } from '@kbn/i18n-react';
import { KibanaContextProvider } from '@kbn/kibana-react-plugin/public';
import type { CoreStart } from '@kbn/core/public';
import type { ManagementAppMountParams } from '@kbn/management-plugin/public';

import { App } from './app';
import type { DeepfreezePluginStartDeps } from './types';

export function renderApp(
  coreStart: CoreStart,
  plugins: DeepfreezePluginStartDeps,
  params: ManagementAppMountParams
) {
  // Set the browser tab title to "Deepfreeze - Elastic" for the
  // duration of the app mount. Reset via `docTitle.reset()` on
  // unmount so the title is restored when the user navigates away.
  coreStart.chrome.docTitle.change('Deepfreeze');

  ReactDOM.render(
    <KibanaContextProvider services={{ ...coreStart, ...plugins }}>
      <I18nProvider>
        <Router history={params.history}>
          <App
            http={coreStart.http}
            notifications={coreStart.notifications}
            setBreadcrumbs={params.setBreadcrumbs}
          />
        </Router>
      </I18nProvider>
    </KibanaContextProvider>,
    params.element
  );

  return () => {
    ReactDOM.unmountComponentAtNode(params.element);
    coreStart.chrome.docTitle.reset();
  };
}
