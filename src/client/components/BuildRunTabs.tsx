import React, { useRef } from 'react';
import { BUILD_RUN_TABS, type BuildRunTabKey } from './buildRunTabList';
import styles from './BuildRunView.module.css';

export function buildRunTabId(key: BuildRunTabKey): string {
  return `build-run-tab-${key}`;
}

export function buildRunPanelId(key: BuildRunTabKey): string {
  return `build-run-panel-${key}`;
}

interface BuildRunTabsProps {
  active: BuildRunTabKey;
  onSelect: (tab: BuildRunTabKey) => void;
}

/** WAI-ARIA tabs with manual activation: arrows move focus, Enter or Space opens the tab. */
export const BuildRunTabs: React.FC<BuildRunTabsProps> = ({ active, onSelect }) => {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const focusTab = (index: number) => {
    const count = BUILD_RUN_TABS.length;
    refs.current[(index + count) % count]?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        focusTab(index + 1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        focusTab(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusTab(0);
        break;
      case 'End':
        event.preventDefault();
        focusTab(BUILD_RUN_TABS.length - 1);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        onSelect(BUILD_RUN_TABS[index].key);
        break;
      default:
        break;
    }
  };

  return (
    <div role="tablist" aria-label="Build sections" className={styles.tablist} {...{ 'data-testid': 'build-run-tabs' }}>
      {BUILD_RUN_TABS.map((tab, index) => {
        const selected = tab.key === active;
        return (
          <button
            key={tab.key}
            ref={(element) => { refs.current[index] = element; }}
            type="button"
            role="tab"
            id={buildRunTabId(tab.key)}
            aria-selected={selected}
            aria-controls={buildRunPanelId(tab.key)}
            tabIndex={selected ? 0 : -1}
            className={`${styles.tab} ${selected ? styles.tabActive : ''}`}
            onClick={() => onSelect(tab.key)}
            onKeyDown={(event) => onKeyDown(event, index)}
            {...{ 'data-testid': `build-run-tab-${tab.key}` }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
};
