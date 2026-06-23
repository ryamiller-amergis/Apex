import React, { useState, useEffect } from 'react';
import styles from './ChangelogBanner.module.css';

interface ChangelogEntry {
  version: string;
  title: string;
}

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
  const [latest, setLatest] = useState<ChangelogEntry | null>(null);

  useEffect(() => {
    fetch('/CHANGELOG.json')
      .then(res => res.json())
      .then((data: ChangelogEntry[]) => {
        if (data.length > 0) setLatest({ version: data[0].version, title: data[0].title });
      })
      .catch(err => console.error('Failed to load changelog:', err));
  }, []);

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
