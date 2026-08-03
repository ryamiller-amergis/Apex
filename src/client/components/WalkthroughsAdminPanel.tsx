import React, { useState } from 'react';
import { WalkthroughCatalog } from './WalkthroughCatalog';
import { WalkthroughAnchorManagement } from './WalkthroughAnchorManagement';
import { WalkthroughReportingSection } from './WalkthroughReportingSection';
import { WalkthroughsAiOptionsPanel } from './WalkthroughsAiOptionsPanel';
import { WalkthroughsAiOptionsProvider } from '../contexts/WalkthroughsAiOptionsContext';
import styles from './WalkthroughAnchorManagement.module.css';

type WalkthroughsAdminSubView = 'walkthroughs' | 'reports' | 'anchors' | 'options';

/**
 * Nested host for Platform Admin → Walkthroughs tab:
 * Walkthroughs (authoring catalog) | Walkthrough Reports | Anchor Management | Options.
 */
export const WalkthroughsAdminPanel: React.FC = () => {
  const [subView, setSubView] = useState<WalkthroughsAdminSubView>('walkthroughs');

  return (
    <WalkthroughsAiOptionsProvider>
      <div className={styles.panel} {...{ 'data-testid': 'walkthroughs-admin-panel' }}>
        <div
          className={styles.subTabBar}
          role="tablist"
          aria-label="Walkthroughs admin views"
        >
          <button
            type="button"
            role="tab"
            id="walkthroughs-admin-tab-walkthroughs"
            aria-selected={subView === 'walkthroughs'}
            aria-controls="walkthroughs-admin-panel-walkthroughs"
            className={styles.subTab}
            onClick={() => setSubView('walkthroughs')}
            {...{ 'data-testid': 'walkthroughs-admin-tab-walkthroughs' }}
          >
            Walkthroughs
          </button>
          <button
            type="button"
            role="tab"
            id="walkthroughs-admin-tab-reports"
            aria-selected={subView === 'reports'}
            aria-controls="walkthroughs-admin-panel-reports"
            className={styles.subTab}
            onClick={() => setSubView('reports')}
            {...{ 'data-testid': 'walkthroughs-admin-tab-reports' }}
          >
            Walkthrough Reports
          </button>
          <button
            type="button"
            role="tab"
            id="walkthroughs-admin-tab-anchors"
            aria-selected={subView === 'anchors'}
            aria-controls="walkthroughs-admin-panel-anchors"
            className={styles.subTab}
            onClick={() => setSubView('anchors')}
            {...{ 'data-testid': 'walkthroughs-admin-tab-anchors' }}
          >
            Anchor Management
          </button>
          <button
            type="button"
            role="tab"
            id="walkthroughs-admin-tab-options"
            aria-selected={subView === 'options'}
            aria-controls="walkthroughs-admin-panel-options"
            className={styles.subTab}
            onClick={() => setSubView('options')}
            {...{ 'data-testid': 'walkthroughs-admin-tab-options' }}
          >
            Options
          </button>
        </div>

        {subView === 'walkthroughs' && (
          <div
            id="walkthroughs-admin-panel-walkthroughs"
            role="tabpanel"
            aria-labelledby="walkthroughs-admin-tab-walkthroughs"
            {...{ 'data-testid': 'walkthroughs-admin-panel-walkthroughs' }}
          >
            <WalkthroughCatalog />
          </div>
        )}

        {subView === 'reports' && (
          <div
            id="walkthroughs-admin-panel-reports"
            role="tabpanel"
            aria-labelledby="walkthroughs-admin-tab-reports"
            {...{ 'data-testid': 'walkthroughs-admin-panel-reports' }}
          >
            <WalkthroughReportingSection />
          </div>
        )}

        {subView === 'anchors' && (
          <div
            id="walkthroughs-admin-panel-anchors"
            role="tabpanel"
            aria-labelledby="walkthroughs-admin-tab-anchors"
            {...{ 'data-testid': 'walkthroughs-admin-panel-anchors' }}
          >
            <WalkthroughAnchorManagement />
          </div>
        )}

        {subView === 'options' && (
          <div
            id="walkthroughs-admin-panel-options"
            role="tabpanel"
            aria-labelledby="walkthroughs-admin-tab-options"
            {...{ 'data-testid': 'walkthroughs-admin-panel-options' }}
          >
            {/* data-testid-exempt — WalkthroughsAiOptionsPanel root sets walkthroughs-ai-options */}
            <WalkthroughsAiOptionsPanel />
          </div>
        )}
      </div>
    </WalkthroughsAiOptionsProvider>
  );
};
