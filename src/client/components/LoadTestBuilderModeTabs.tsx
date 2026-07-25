import React from 'react';
import styles from './LoadTestBuilderModeTabs.module.css';

export type BuilderMode = 'guided' | 'raw' | 'ai';

interface LoadTestBuilderModeTabsProps {
  mode: BuilderMode;
  disabled?: boolean;
  onChange: (mode: BuilderMode) => void;
  onAiAttempt?: () => void;
}

export const LoadTestBuilderModeTabs: React.FC<LoadTestBuilderModeTabsProps> = ({
  mode,
  disabled = false,
  onChange,
  onAiAttempt,
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
      <button
        type="button"
        role="tab"
        id="load-test-mode-ai"
        aria-selected={mode === 'ai'}
        aria-controls="load-test-mode-panel"
        className={`${styles.tab} ${styles.disabledTab}`}
        data-testid="load-test-mode-ai"
        disabled
        aria-disabled="true"
        title="AI generate will be available in a later release"
        onClick={() => onAiAttempt?.()}
      >
        AI generate
      </button>
    </div>
  );
};

export default LoadTestBuilderModeTabs;
