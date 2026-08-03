import React from 'react';
import styles from './ApexFixRunningBanner.module.css';

interface ApexFixRunningBannerProps {
  title: string;
  subtitle?: string;
  /** Muted duration / timing hint shown after the title, e.g. "Typically 1–3 min". */
  hint?: string;
  onCancel?: () => void;
}

export const ApexFixRunningBanner: React.FC<ApexFixRunningBannerProps> = ({
  title,
  subtitle,
  hint,
  onCancel,
}) => (
  <div className={styles.banner} role="status" aria-live="polite">
    <span className={styles.pulse} aria-hidden="true" />
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
      <div className={styles.titleRow}>
        <span className={styles.title}>{title}</span>
        {hint && <span className={styles.hint}>{hint}</span>}
      </div>
      {subtitle && <div className={styles.subtitle}>{subtitle}</div>}
    </div>
    {onCancel && (
      <button className={styles.cancelBtn} onClick={onCancel} type="button">
        Cancel
      </button>
    )}
  </div>
);
