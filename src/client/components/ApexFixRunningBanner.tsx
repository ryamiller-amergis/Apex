import React from 'react';
import styles from './ApexFixRunningBanner.module.css';

interface ApexFixRunningBannerProps {
  title: string;
  subtitle?: string;
}

export const ApexFixRunningBanner: React.FC<ApexFixRunningBannerProps> = ({ title, subtitle }) => (
  <div className={styles.banner} role="status" aria-live="polite">
    <svg
      className={styles.spinner}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
    <div className={styles.text}>
      <div className={styles.title}>{title}</div>
      {subtitle && <div className={styles.subtitle}>{subtitle}</div>}
    </div>
  </div>
);
