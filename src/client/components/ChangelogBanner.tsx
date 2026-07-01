import React from 'react';
import { useChangelog } from '../hooks/useChangelog';
import styles from './ChangelogBanner.module.css';

interface ChangelogBannerProps {
  onOpenChangelog: () => void;
  onMarkAsRead: () => void;
  onToggleShowOnLogin: (show: boolean) => void;
}

export const ChangelogBanner: React.FC<ChangelogBannerProps> = ({
  onOpenChangelog,
  onMarkAsRead,
  onToggleShowOnLogin,
}) => {
  const { data } = useChangelog(true);
  const latest = data?.entries[0] ?? null;

  if (!latest) return null;

  return (
    <div className={styles.banner}>
      <span className={styles.icon}>✨</span>
      <div className={styles.content}>
        <p className={styles.headline}>
          What&apos;s New in <strong>v{latest.version}</strong> &mdash; {latest.title}
        </p>
      </div>
      <div className={styles.actions}>
        <button type="button" className={styles.seeNewBtn} onClick={onOpenChangelog}>
          See what&apos;s new
        </button>
        <button
          type="button"
          className={styles.toggleLink}
          onClick={() => onToggleShowOnLogin(false)}
        >
          Don&apos;t show automatically
        </button>
        <button type="button" className={styles.dismissBtn} onClick={onMarkAsRead} aria-label="Dismiss">
          ×
        </button>
      </div>
    </div>
  );
};
