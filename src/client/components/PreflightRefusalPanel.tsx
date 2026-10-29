import React, { useEffect, useRef } from 'react';
import type { PreflightRefusalResponse } from '../../shared/types/buildPreflight';
import styles from './PreflightRefusalPanel.module.css';

interface PreflightRefusalPanelProps {
  response: PreflightRefusalResponse;
}

export const PreflightRefusalPanel: React.FC<PreflightRefusalPanelProps> = ({ response }) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const hasRefusals = response.refusals.length > 0;

  useEffect(() => {
    if (hasRefusals) panelRef.current?.focus();
  }, [hasRefusals, response]);

  if (!hasRefusals) return null;

  return (
    <div
      ref={panelRef}
      className={styles.panel}
      role="alert"
      tabIndex={-1}
      {...{ 'data-testid': 'preflight-refusal-panel' }}
    >
      <p className={styles.summary}>{response.summary}</p>
      <ul className={styles.list}>
        {response.refusals.map((refusal) => (
          <li
            key={`${refusal.code}-${refusal.item}`}
            className={styles.item}
            {...{ 'data-testid': `preflight-refusal-item-${refusal.code}` }}
          >
            <p className={styles.itemName}>Missing: {refusal.item}</p>
            <p className={styles.message}>{refusal.message}</p>
            <p className={styles.fixer}>Who can fix it: {refusal.fixerLabel}</p>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default PreflightRefusalPanel;
