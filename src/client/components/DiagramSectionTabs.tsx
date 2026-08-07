import React from 'react';
import styles from './DiagramSectionTabs.module.css';

export type DiagramBrowseSection = 'owned' | 'shared';

interface DiagramSectionTabsProps {
  activeTab: DiagramBrowseSection;
  onChange: (tab: DiagramBrowseSection) => void;
  'data-testid'?: string;
}

export const DiagramSectionTabs: React.FC<DiagramSectionTabsProps> = ({
  activeTab,
  onChange,
  'data-testid': testId = 'diagrams-section-tabs',
}) => {
  return (
    <div
      className={styles.tabs}
      role="tablist"
      aria-label="Diagram sections"
      {...{ 'data-testid': testId }}
    >
      <button
        type="button"
        role="tab"
        id="diagrams-tab-owned"
        aria-selected={activeTab === 'owned'}
        aria-controls="diagrams-panel-owned"
        className={`${styles.tab} ${activeTab === 'owned' ? styles.active : ''}`}
        onClick={() => onChange('owned')}
        {...{ 'data-testid': 'diagrams-tab-owned' }}
      >
        My Diagrams
      </button>
      <button
        type="button"
        role="tab"
        id="diagrams-tab-shared"
        aria-selected={activeTab === 'shared'}
        aria-controls="diagrams-panel-shared"
        className={`${styles.tab} ${activeTab === 'shared' ? styles.active : ''}`}
        onClick={() => onChange('shared')}
        {...{ 'data-testid': 'diagrams-tab-shared' }}
      >
        Shared with me
      </button>
    </div>
  );
};

export default DiagramSectionTabs;
