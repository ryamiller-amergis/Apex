/**
 * FEAT-006 — Canonical Help / Walkthroughs replay list (opened from Apex FAB).
 */
import React, { useEffect, useId, useRef } from 'react';
import type { WalkthroughReplayEntry } from '../../shared/types/walkthrough';
import styles from './WalkthroughHelpPanel.module.css';

export interface WalkthroughHelpPanelProps {
  open: boolean;
  loading: boolean;
  error: boolean;
  items: WalkthroughReplayEntry[];
  onClose: () => void;
  onRetry: () => void;
  onSelect: (entry: WalkthroughReplayEntry) => void;
  selectingId?: string | null;
  'data-testid'?: string;
}

export const WalkthroughHelpPanel: React.FC<WalkthroughHelpPanelProps> = ({
  open,
  loading,
  error,
  items,
  onClose,
  onRetry,
  onSelect,
  selectingId = null,
  'data-testid': rootTestId = 'walkthrough-help-panel',
}) => {
  const titleId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  const newItems = items.filter((i) => i.state === 'new');
  const acknowledgedItems = items.filter((i) => i.state === 'acknowledged');

  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => headingRef.current?.focus(), 0);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
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

    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocusedRef.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className={styles.backdrop}>
      <div
        ref={dialogRef}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={loading}
        {...{ 'data-testid': rootTestId }}
      >
        <div className={styles.header}>
          <h2
            id={titleId}
            ref={headingRef}
            className={styles.title}
            tabIndex={-1}
          >
            Walkthroughs
          </h2>
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            aria-label="Close Walkthroughs"
            {...{ 'data-testid': 'walkthrough-help-close' }}
          >
            ✕
          </button>
        </div>

        {loading && (
          <div
            className={styles.loading}
            {...{ 'data-testid': 'walkthrough-help-loading' }}
          >
            <div className={styles.skeleton} />
            <div className={styles.skeleton} />
            <div className={styles.skeleton} />
          </div>
        )}

        {!loading && error && (
          <div
            className={styles.error}
            {...{ 'data-testid': 'walkthrough-help-error' }}
          >
            <p>Walkthroughs are temporarily unavailable.</p>
            <button
              type="button"
              className={styles.retry}
              onClick={onRetry}
              {...{ 'data-testid': 'walkthrough-help-retry' }}
            >
              Retry
            </button>
          </div>
        )}

        {!loading && !error && items.length === 0 && (
          <div
            className={styles.empty}
            {...{ 'data-testid': 'walkthrough-help-empty' }}
          >
            No Walkthroughs are available for this project.
          </div>
        )}

        {!loading && !error && items.length > 0 && (
          <div className={styles.sections}>
            <section
              className={styles.section}
              aria-labelledby="walkthrough-list-new-heading"
              {...{ 'data-testid': 'walkthrough-list-new' }}
            >
              <h3 id="walkthrough-list-new-heading" className={styles.sectionTitle}>
                New
              </h3>
              {newItems.length === 0 ? (
                <p className={styles.sectionEmpty}>No New Walkthroughs</p>
              ) : (
                <ul className={styles.list}>
                  {newItems.map((entry) => (
                    <li key={entry.walkthrough.id}>
                      <button
                        type="button"
                        className={styles.item}
                        disabled={selectingId === entry.walkthrough.id}
                        onClick={() => onSelect(entry)}
                        {...{
                          'data-testid': `walkthrough-replay-${entry.walkthrough.id}`,
                        }}
                      >
                        <span className={styles.itemTitle}>{entry.walkthrough.userTitle}</span>
                        <span className={styles.itemMeta}>New</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section
              className={styles.section}
              aria-labelledby="walkthrough-list-acknowledged-heading"
              {...{ 'data-testid': 'walkthrough-list-acknowledged' }}
            >
              <h3
                id="walkthrough-list-acknowledged-heading"
                className={styles.sectionTitle}
              >
                Acknowledged
              </h3>
              {acknowledgedItems.length === 0 ? (
                <p className={styles.sectionEmpty}>No Acknowledged Walkthroughs</p>
              ) : (
                <ul className={styles.list}>
                  {acknowledgedItems.map((entry) => (
                    <li key={entry.walkthrough.id}>
                      <button
                        type="button"
                        className={styles.item}
                        disabled={selectingId === entry.walkthrough.id}
                        onClick={() => onSelect(entry)}
                        {...{
                          'data-testid': `walkthrough-replay-${entry.walkthrough.id}`,
                        }}
                      >
                        <span className={styles.itemTitle}>{entry.walkthrough.userTitle}</span>
                        <span className={styles.itemMeta}>
                          {entry.progress?.status === 'dismissed' ? 'Dismissed' : 'Completed'}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
};
