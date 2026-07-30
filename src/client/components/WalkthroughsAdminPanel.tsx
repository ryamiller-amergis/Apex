import React, { useState } from 'react';
import { WalkthroughCatalog } from './WalkthroughCatalog';
import { WalkthroughAnchorManagement } from './WalkthroughAnchorManagement';
import styles from './WalkthroughAnchorManagement.module.css';

type WalkthroughsAdminSubView = 'walkthroughs' | 'anchors';

/**
 * Nested host for Platform Admin → Walkthroughs tab:
 * Walkthroughs (authoring catalog) | Anchor Management (UI shell).
 */
export const WalkthroughsAdminPanel: React.FC = () => {
  const [subView, setSubView] = useState<WalkthroughsAdminSubView>('walkthroughs');

  return (
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
          id="walkthroughs-admin-tab-anchors"
          aria-selected={subView === 'anchors'}
          aria-controls="walkthroughs-admin-panel-anchors"
          className={styles.subTab}
          onClick={() => setSubView('anchors')}
          {...{ 'data-testid': 'walkthroughs-admin-tab-anchors' }}
        >
          Anchor Management
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
    </div>
  );
};
