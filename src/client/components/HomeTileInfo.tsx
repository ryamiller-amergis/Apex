/**
 * Info affordance for the Agent Home dashboard cards.
 *
 * Mirrors the walkthrough sync-review info icon (`WalkthroughAnchorSyncReviewModal`):
 * an accent circled "i" that toggles a short explanation of what the card counts and
 * where the numbers come from.
 */
import React, { useEffect, useRef, useState } from 'react';
import styles from './HomeDashboardTiles.module.css';

const InfoIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z" />
    <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z" />
  </svg>
);

export interface HomeTileInfoProps {
  /** Card name, used to label the trigger and the panel. */
  title: string;
  children: React.ReactNode;
  'data-testid'?: string;
}

export const HomeTileInfo: React.FC<HomeTileInfoProps> = ({
  title,
  children,
  'data-testid': testId,
}) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return undefined;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onPointerDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  /**
   * My Work and Dev → Production wrap the whole card in an `<a>`, so a bare click
   * here would follow that link. Cancelling the default action is what stops the
   * navigation; halting propagation keeps the card's own handlers out of it too.
   */
  const contain = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <span className={styles['info-wrap']} ref={wrapRef}>
      <button
        type="button"
        className={styles['info-icon']}
        onClick={(e) => {
          contain(e);
          setOpen((v) => !v);
        }}
        aria-label={`About ${title}`}
        aria-expanded={open}
        {...(testId ? { 'data-testid': testId } : {})}
      >
        <InfoIcon />
      </button>
      {open && (
        <div
          className={styles['info-popover']}
          role="dialog"
          aria-label={`About ${title}`}
          onClick={contain}
          {...(testId ? { 'data-testid': `${testId}-panel` } : {})}
        >
          <button
            type="button"
            className={styles['info-close']}
            onClick={(e) => {
              contain(e);
              setOpen(false);
            }}
            aria-label="Close information"
            {...{ 'data-testid': testId ? `${testId}-close` : 'home-tile-info-close' }}
          >
            ×
          </button>
          {children}
        </div>
      )}
    </span>
  );
};

export default HomeTileInfo;
