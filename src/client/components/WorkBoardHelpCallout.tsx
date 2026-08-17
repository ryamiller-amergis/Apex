import React, { useState } from 'react';
import styles from './WorkBoardHelpCallout.module.css';

const STORAGE_KEY = 'apex-work-board-help-dismissed';

function isDismissed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * One-time help blurb at the top of the Work Board (localStorage-dismissed).
 */
export const WorkBoardHelpCallout: React.FC = () => {
  const [visible, setVisible] = useState(() => !isDismissed());

  if (!visible) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      // private mode / quota
    }
    setVisible(false);
  };

  return (
    <aside className={styles.callout} role="note" data-testid="work-board-help-callout">
      <div className={styles.body}>
        <strong className={styles.title}>Getting around the Work Board</strong>
        <p className={styles.text}>
          Use the <em>Release lens</em> to plan by target release, switch to <em>Backlog</em> for a
          flat prioritized list, and open Standup from the nav for daily ceremony updates tied to
          your board items.
        </p>
      </div>
      <button type="button" className={styles.dismiss} onClick={dismiss} aria-label="Dismiss help">
        Got it
      </button>
    </aside>
  );
};
