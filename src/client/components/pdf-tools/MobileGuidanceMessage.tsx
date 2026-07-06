import React from 'react';
import styles from './MobileGuidanceMessage.module.css';

export const MobileGuidanceMessage: React.FC = () => (
  <main className={styles.container} data-testid="pdf-tools-mobile-guidance">
    <div className={styles.content}>
      <div className={styles.iconWrapper} aria-hidden="true">
        <svg
          width="48"
          height="48"
          viewBox="0 0 48 48"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="8" y="6" width="32" height="36" rx="3" />
          <path d="M16 16h16M16 22h16M16 28h10" />
        </svg>
      </div>
      <h1 className={styles.heading}>PDF Tools is available on desktop</h1>
      <p className={styles.body}>
        Please switch to a desktop browser to use the PDF assembly workspace.
      </p>
    </div>
  </main>
);
