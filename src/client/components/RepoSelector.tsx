import React from 'react';
import type { ProjectRepoConfigSummary } from '../../shared/types/projectSettings';
import styles from './RepoSelector.module.css';

interface RepoSelectorProps {
  configs: ProjectRepoConfigSummary[];
  onSelect: (settingsId: string) => void;
  onBack?: () => void;
}

export const RepoSelector: React.FC<RepoSelectorProps> = ({ configs, onSelect, onBack }) => {
  return (
    <div className={styles.overlay}>
      <div className={styles.header}>
        <h2 className={styles.title}>Select a repository configuration</h2>
        <p className={styles.subtitle}>This project has multiple repo configurations. Choose one to continue.</p>
      </div>

      <div className={styles.grid}>
        {configs.map((config) => (
          <button
            key={config.id}
            className={styles.card}
            onClick={() => onSelect(config.id)}
            type="button"
          >
            <div className={styles.cardIcon}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 3v12" />
                <circle cx="18" cy="6" r="3" />
                <circle cx="6" cy="18" r="3" />
                <path d="M18 9a9 9 0 0 1-9 9" />
              </svg>
            </div>
            <div className={styles.cardBody}>
              <span className={styles.cardName}>{config.friendlyName}</span>
              <span className={styles.cardMeta}>
                {config.skillRepo} / {config.skillBranch}
              </span>
            </div>
            {config.isDefault && (
              <span className={styles.defaultBadge}>Default</span>
            )}
          </button>
        ))}
      </div>

      {onBack && (
        <button type="button" className={styles.backButton} onClick={onBack}>
          &larr; Back to projects
        </button>
      )}
    </div>
  );
};
