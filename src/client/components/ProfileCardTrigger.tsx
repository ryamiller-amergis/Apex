/**
 * FEAT-004 / TBI-007 — Keyboard/touch button that opens a modal ProfileCard.
 * Owns open/close, Escape dismissal, and focus restoration.
 */
import React, { useEffect, useId, useRef, useState } from 'react';
import { ProfileCard } from './ProfileCard';
import { SharedAvatar } from './SharedAvatar';
import styles from './ProfileCardTrigger.module.css';

export interface ProfileCardTriggerProps {
  oid: string;
  displayName: string;
  avatarVersion?: string | null;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  /** Accessible name override; defaults to "View profile for {displayName}". */
  ariaLabel?: string;
  children?: React.ReactNode;
}

export const ProfileCardTrigger: React.FC<ProfileCardTriggerProps> = ({
  oid,
  displayName,
  avatarVersion = null,
  size = 'md',
  className,
  ariaLabel,
  children,
}) => {
  const [open, setOpen] = useState(false);
  const trimmedOid = oid.trim();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const label =
    ariaLabel ?? `View profile for ${displayName.trim() || 'user'}`;

  useEffect(() => {
    if (!open) return;

    const triggerEl = triggerRef.current;
    closeRef.current?.focus();

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      triggerEl?.focus();
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={[styles.trigger, className].filter(Boolean).join(' ')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        data-testid={`profile-card-trigger-${trimmedOid}`}
        onClick={() => setOpen(true)}
      >
        {children ?? (
          <SharedAvatar
            oid={trimmedOid}
            displayName={displayName}
            avatarVersion={avatarVersion}
            size={size}
            decorative
          />
        )}
      </button>

      {open && (
        <div
          className={styles.overlay}
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
          >
            <div className={styles.dialogChrome}>
              <span id={titleId} className={styles.srOnly}>
                Profile for {displayName}
              </span>
              <button
                ref={closeRef}
                type="button"
                className={styles.close}
                data-testid={`profile-card-close-${trimmedOid}`}
                aria-label="Close profile card"
                onClick={() => setOpen(false)}
              >
                Close
              </button>
            </div>
            <ProfileCard oid={trimmedOid} displayNameHint={displayName} />
          </div>
        </div>
      )}
    </>
  );
};

export default ProfileCardTrigger;
