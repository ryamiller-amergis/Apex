import React, { useState, useEffect, useRef } from 'react';
import type { ChangelogEntry } from '../../shared/types/changelog';
import { semverGt, semverValid } from '../../shared/utils/semverStrict';
import { useChangelog } from '../hooks/useChangelog';
import styles from './Changelog.module.css';

interface ChangelogProps {
  isOpen: boolean;
  onClose: () => void;
  onMarkAsRead: () => void;
  showOnLogin: boolean;
  onToggleShowOnLogin: (show: boolean) => void;
  /** Pre-acknowledgement boundary for “New since last visit” divider. */
  lastSeenVersion?: string | null;
  /** Benign unavailable state for manual opens when changelog failed. */
  manualUnavailable?: boolean;
}

function findUnseenDividerIndex(
  entries: ChangelogEntry[],
  lastSeenVersion: string | null | undefined,
): number {
  const boundary = semverValid(lastSeenVersion ?? null);
  if (!boundary) return -1;
  return entries.findIndex((entry) => {
    const v = semverValid(entry.version);
    return v ? semverGt(v, boundary) : false;
  });
}

export const Changelog: React.FC<ChangelogProps> = ({
  isOpen,
  onClose,
  onMarkAsRead,
  showOnLogin,
  onToggleShowOnLogin,
  lastSeenVersion = null,
  manualUnavailable = false,
}) => {
  const { data, isLoading, isError } = useChangelog(isOpen && !manualUnavailable);
  const changelog: ChangelogEntry[] = data?.entries ?? [];
  const currentVersion = data?.currentVersion ?? null;
  const [expandedVersions, setExpandedVersions] = useState<Set<string>>(new Set());
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (currentVersion) {
      setExpandedVersions(new Set([currentVersion]));
    }
  }, [currentVersion]);

  useEffect(() => {
    if (!isOpen) return;
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    const focusTimer = window.setTimeout(() => {
      closeBtnRef.current?.focus();
    }, 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        handleClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocusedRef.current?.focus?.();
    };
    // handleClose is stable enough for dismiss-on-escape within an open instance
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const toggleVersion = (version: string) => {
    const newExpanded = new Set(expandedVersions);
    if (newExpanded.has(version)) newExpanded.delete(version);
    else newExpanded.add(version);
    setExpandedVersions(newExpanded);
  };

  const handleClose = () => {
    if (manualUnavailable || isError) {
      onClose();
      return;
    }
    // Acknowledgement clears unread and closes via useWhatsNewState.
    onMarkAsRead();
  };

  const getChangeIcon = (type: string) => {
    const icons: Record<string, string> = { feature: '✨', improvement: '🚀', bugfix: '🐛', breaking: '⚠️' };
    return icons[type] || '•';
  };

  const getChangeClass = (type: string): string => {
    const map: Record<string, string> = {
      feature: styles['change-feature'],
      improvement: styles['change-improvement'],
      bugfix: styles['change-bugfix'],
      breaking: styles['change-breaking'],
    };
    return map[type] || '';
  };

  if (!isOpen) return null;

  const showUnavailable = manualUnavailable || isError;
  const dividerIndex = findUnseenDividerIndex(changelog, lastSeenVersion);

  return (
    <>
      <button
        type="button"
        className={styles['changelog-overlay']}
        onClick={handleClose}
        aria-label="Close What's New"
      />
      <div
        ref={dialogRef}
        className={styles['changelog-modal']}
        role="dialog"
        aria-modal="true"
        aria-labelledby="whats-new-title"
        data-testid="whats-new-modal"
      >
        <div className={styles['changelog-header']}>
          <div>
            <h2 id="whats-new-title">What's New</h2>
            <p className={styles['changelog-subtitle']}>Recent updates and improvements</p>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={handleClose}
            className={styles['changelog-close-btn']}
            aria-label="Close What's New"
          >
            ×
          </button>
        </div>

        <div className={styles['changelog-content']}>
          {showUnavailable ? (
            <div
              className={styles['changelog-loading']}
              data-testid="whats-new-manual-unavailable"
            >
              Release notes are temporarily unavailable
            </div>
          ) : isLoading ? (
            <div className={styles['changelog-loading']} aria-live="polite">
              Loading release notes…
            </div>
          ) : changelog.length === 0 ? (
            <div className={styles['changelog-loading']}>No release notes are available</div>
          ) : (
            <div className={styles['changelog-list']}>
              {changelog.map((entry, index) => (
                <React.Fragment key={entry.version}>
                  {index === dividerIndex && (
                    <div
                      className={styles['changelog-unseen-divider']}
                      data-testid="whats-new-unseen-divider"
                      role="separator"
                      aria-label="New since last visit"
                    >
                      New since last visit
                    </div>
                  )}
                  <div className={styles['changelog-entry']}>
                    <button
                      type="button"
                      className={styles['changelog-entry-header']}
                      onClick={() => toggleVersion(entry.version)}
                      aria-expanded={expandedVersions.has(entry.version)}
                    >
                      <div className={styles['changelog-entry-info']}>
                        <div className={styles['changelog-version-row']}>
                          <span className={styles['changelog-version']}>v{entry.version}</span>
                          {entry.version === currentVersion && (
                            <span className={styles['changelog-new-badge']}>NEW</span>
                          )}
                        </div>
                        <h3 className={styles['changelog-title']}>{entry.title}</h3>
                        <span className={styles['changelog-date']}>
                          {new Date(entry.date).toLocaleDateString('en-US', {
                            year: 'numeric',
                            month: 'long',
                            day: 'numeric',
                          })}
                        </span>
                      </div>
                      <span className={styles['changelog-toggle']} aria-hidden="true">
                        {expandedVersions.has(entry.version) ? '▼' : '▶'}
                      </span>
                    </button>

                    {expandedVersions.has(entry.version) && (
                      <div className={styles['changelog-changes']}>
                        {entry.changes.map((change, changeIndex) => (
                          <div
                            key={changeIndex}
                            className={`${styles['changelog-change']} ${getChangeClass(change.type)}`}
                          >
                            <span className={styles['change-icon']}>{getChangeIcon(change.type)}</span>
                            <span className={styles['change-description']}>{change.description}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </React.Fragment>
              ))}
            </div>
          )}
        </div>

        <div className={styles['changelog-footer']}>
          {!showUnavailable && (
            <label className={styles['changelog-show-toggle']}>
              <input
                type="checkbox"
                checked={showOnLogin}
                onChange={(e) => onToggleShowOnLogin(e.target.checked)}
                data-testid="whats-new-auto-toggle"
              />
              Show automatically on login
            </label>
          )}
          <button type="button" onClick={handleClose} className={styles['changelog-done-btn']}>
            {showUnavailable ? 'Dismiss' : 'Got it!'}
          </button>
        </div>
      </div>
    </>
  );
};
