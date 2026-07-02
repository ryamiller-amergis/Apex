import React from 'react';
import styles from './MobileGuidanceMessage.module.css';

const IconDesktop: React.FC = () => (
  <svg
    width="48"
    height="48"
    viewBox="0 0 48 48"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="4" y="6" width="40" height="28" rx="3" />
    <path d="M16 42h16M24 34v8" />
  </svg>
);

export const MobileGuidanceMessage: React.FC = () => (
  <main className={styles.container} data-testid="pdf-tools-mobile-guidance">
    <div className={styles.content}>
      <span className={styles.icon}>
        <IconDesktop />
      </span>
      <h1 className={styles.heading}>Desktop required</h1>
      <p className={styles.message}>
        PDF Tools is available on desktop browsers. Please switch to a desktop
        device to use this feature.
      </p>
    </div>
  </main>
);
