import React, { useEffect } from 'react';
import styles from './BetaAnnouncementModal.module.css';

interface BetaAnnouncementModalProps {
  isSuperAdmin: boolean;
  onDismiss: () => void;
}

export const BetaAnnouncementModal: React.FC<BetaAnnouncementModalProps> = ({ isSuperAdmin, onDismiss }) => {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  return (
    <div className={styles['overlay']} role="dialog" aria-modal="true" aria-labelledby="beta-announcement-title">
      <div className={styles['card']}>
        <div className={styles['header']}>
          <div className={styles['icon']}>🚀</div>
          <h2 id="beta-announcement-title" className={styles['title']}>
            Welcome to Apex Production
          </h2>
        </div>

        <div className={styles['body']}>
          <p>
            Thank you for being part of the Apex beta initiative. Your feedback and engagement
            helped shape the platform into what it is today, and we're grateful for your
            contribution during that journey.
          </p>
          <p>
            We're excited to announce that Apex has officially moved to a dedicated production
            instance — bringing improved reliability, performance, and a host of new features
            built from the insights you shared.
          </p>
          <p>
            Your work from beta has been transferred to production — projects, work items,
            conversations, and preferences — so you can pick up right where you left off
            without missing a beat.
          </p>
          <ul className={styles['highlights']}>
            <li><span>🔄</span> Your beta data migrated to production</li>
            <li><span>⚡</span> Enhanced performance and stability</li>
            <li><span>🔒</span> Dedicated production infrastructure</li>
            <li><span>✨</span> New features and workflow enhancements</li>
            <li><span>📊</span> Improved analytics and reporting</li>
          </ul>
          <p>
            This is your new home — same team, same mission, same work — now with an even
            stronger foundation to build on.
          </p>
        </div>

        <div className={styles['footer']}>
          {isSuperAdmin ? (
            <button className={styles['dismiss-btn']} onClick={onDismiss}>
              Got it, let's go!
            </button>
          ) : (
            <a
              className={styles['redirect-btn']}
              href="https://apex.amergis.com/"
              rel="noopener noreferrer"
            >
              Go to Apex Production
            </a>
          )}
        </div>
      </div>
    </div>
  );
};
