import React from 'react';
import { useChangelog } from '../hooks/useChangelog';
import styles from './WhatsNewBanner.module.css';

export interface WhatsNewBannerProps {
  currentVersion?: string | null;
  onOpenChangelog: () => void;
  onMarkAsRead: () => void;
  onToggleShowOnLogin?: (show: boolean) => void;
}

/**
 * Passive project-selector What's New banner (FEAT-006).
 * Visibility is owned by the parent via unread state — not gated by auto-login preference.
 */
export const WhatsNewBanner: React.FC<WhatsNewBannerProps> = ({
  currentVersion,
  onOpenChangelog,
  onMarkAsRead,
  onToggleShowOnLogin,
}) => {
  const { data } = useChangelog(true);
  const latest = data?.entries[0] ?? null;
  const version = currentVersion ?? latest?.version ?? null;

  if (!latest && !version) return null;

  const title = latest?.title ?? 'New release';
  const displayVersion = version ?? latest?.version;

  return (
    <div
      className={styles.banner}
      role="region"
      aria-label="What's New"
      data-testid="whats-new-banner"
    >
      <span className={styles.icon} aria-hidden="true">
        ✨
      </span>
      <div className={styles.content}>
        <p className={styles.headline}>
          What&apos;s New in <strong>v{displayVersion}</strong>
          {title ? <> &mdash; {title}</> : null}
        </p>
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.seeNewBtn}
          onClick={onOpenChangelog}
          data-testid="whats-new-banner-open"
        >
          See what&apos;s new
        </button>
        {onToggleShowOnLogin && (
          <button
            type="button"
            className={styles.toggleLink}
            onClick={() => onToggleShowOnLogin(false)}
          >
            Don&apos;t show automatically
          </button>
        )}
        <button
          type="button"
          className={styles.dismissBtn}
          onClick={onMarkAsRead}
          aria-label={
            displayVersion
              ? `Dismiss What's New for version ${displayVersion}`
              : "Dismiss What's New"
          }
          data-testid="whats-new-banner-dismiss"
        >
          ×
        </button>
      </div>
    </div>
  );
};
