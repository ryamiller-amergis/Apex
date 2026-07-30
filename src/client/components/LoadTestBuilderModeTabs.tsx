import React from 'react';
import styles from './LoadTestBuilderModeTabs.module.css';

export type BuilderMode = 'guided' | 'raw';

interface LoadTestBuilderModeTabsProps {
  mode: BuilderMode;
  disabled?: boolean;
  onChange: (mode: BuilderMode) => void;
}

export const LoadTestBuilderModeTabs: React.FC<LoadTestBuilderModeTabsProps> = ({
  mode,
  disabled = false,
  onChange,
}) => {
  return (
    <div
      className={styles.tabs}
      role="tablist"
      aria-label="Load test authoring mode"
      data-testid="load-test-mode-tabs"
    >
      <button
        type="button"
        role="tab"
        id="load-test-mode-guided"
        aria-selected={mode === 'guided'}
        aria-controls="load-test-mode-panel"
        className={`${styles.tab} ${mode === 'guided' ? styles.active : ''}`}
        data-testid="load-test-mode-guided"
        disabled={disabled}
        onClick={() => onChange('guided')}
      >
        Guided
      </button>
      <button
        type="button"
        role="tab"
        id="load-test-mode-raw"
        aria-selected={mode === 'raw'}
        aria-controls="load-test-mode-panel"
        className={`${styles.tab} ${mode === 'raw' ? styles.active : ''}`}
        data-testid="load-test-mode-raw"
        disabled={disabled}
        onClick={() => onChange('raw')}
      >
        Raw script
      </button>
    </div>
  );
};

export default LoadTestBuilderModeTabs;
