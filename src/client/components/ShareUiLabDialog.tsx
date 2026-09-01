import React, { useEffect, useId, useRef, useState } from 'react';
import type { UiLabShare, UiLabShareTarget } from '../../shared/types/uiLab';
import {
  useCreateUiLabShare,
  useRevokeUiLabShare,
  useUiLabShareTargets,
  useUiLabShares,
} from '../hooks/useUiLab';
import dialogShell from './DiagramDialog.module.css';
import styles from './ShareUiLabDialog.module.css';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface ShareUiLabDialogProps {
  designId: string;
  designTitle: string;
  shareLink: string;
  onClose: () => void;
}

export const ShareUiLabDialog: React.FC<ShareUiLabDialogProps> = ({
  designId,
  designTitle,
  shareLink,
  onClose,
}) => {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const [query, setQuery] = useState('');
  const [selectedTarget, setSelectedTarget] = useState<UiLabShareTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const sharesQuery = useUiLabShares(designId, true);
  const targetsQuery = useUiLabShareTargets(designId, query, true);
  const createMutation = useCreateUiLabShare(designId);
  const revokeMutation = useRevokeUiLabShare(designId);

  const busy = createMutation.isPending || revokeMutation.isPending;

  useEffect(() => {
    closeRef.current?.focus();

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!busy) onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [busy, onClose]);

  const handleAdd = () => {
    if (!selectedTarget) {
      setError('Select a project member to share with');
      return;
    }
    if (selectedTarget.alreadyShared) {
      setError('This member already has view access');
      return;
    }
    setError(null);
    createMutation.mutate(
      { granteeId: selectedTarget.userId },
      {
        onError: (err) => {
          setError(err.message || 'Failed to add share');
        },
        onSuccess: () => {
          setSelectedTarget(null);
        },
      },
    );
  };

  const handleRevoke = (share: UiLabShare) => {
    setError(null);
    revokeMutation.mutate(share.granteeId, {
      onError: (err) => {
        setError(err.message || 'Failed to revoke share');
      },
    });
  };

  const handleCopy = async () => {
    try {
      const absolute = `${window.location.origin}${shareLink}`;
      await navigator.clipboard.writeText(absolute);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy link');
    }
  };

  const shares = sharesQuery.data ?? [];
  const targets = targetsQuery.data ?? [];

  return (
    <div
      className={dialogShell.overlay}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid="share-ui-lab-dialog"
    >
      <div className={styles.dialog} ref={dialogRef}>
        <h2 className={styles.title} id={titleId}>
          Share &ldquo;{designTitle}&rdquo;
        </h2>
        <p className={styles.subtitle}>
          Grant view-only access to selected project members. They can preview the design,
          view source, browse versions, and leave comments — but cannot edit.
        </p>

        {error && (
          <p className={styles.error} role="alert" aria-live="assertive" data-testid="share-error">
            {error}
          </p>
        )}

        <div className={styles.copyRow}>
          <input
            className={styles.linkInput}
            type="text"
            readOnly
            value={`${typeof window !== 'undefined' ? window.location.origin : ''}${shareLink}`}
            aria-label="Share link"
            data-testid="share-link-input"
          />
          <button
            type="button"
            className={styles.btnPrimary}
            onClick={handleCopy}
            data-testid="share-copy-link"
          >
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>

        <div className={styles.addForm}>
          <label className={styles.fieldLabel}>
            Project member
            <input
              className={styles.input}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search teammates"
              aria-label="Search project members"
              data-testid="share-target-search"
            />
          </label>
          {targetsQuery.isLoading ? (
            <div className={styles.skeleton} aria-busy="true" aria-label="Loading members" />
          ) : targets.length === 0 ? (
            <p className={styles.empty}>No other project members to share with</p>
          ) : (
            <ul
              className={styles.targetList}
              role="listbox"
              aria-label="Eligible share targets"
              data-testid="share-target-list"
            >
              {targets.map((target) => {
                const label = target.displayName ?? target.email ?? target.userId;
                const selected = selectedTarget?.userId === target.userId;
                return (
                  <li key={target.userId}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={`${styles.targetOption} ${selected ? styles.targetOptionSelected : ''}`}
                      onClick={() => {
                        setSelectedTarget(target);
                        setError(null);
                      }}
                      data-testid={`share-target-${target.userId}`}
                    >
                      <span>{label}</span>
                      <span className={styles.targetMeta}>
                        {target.alreadyShared ? 'Already shared' : 'Not shared'}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <button
            type="button"
            className={styles.btnPrimary}
            onClick={handleAdd}
            disabled={busy || !selectedTarget || selectedTarget.alreadyShared}
            data-testid="share-add-button"
          >
            {createMutation.isPending ? 'Sharing…' : 'Share view access'}
          </button>
        </div>

        <div>
          <h3 className={styles.subtitle}>People with access</h3>
          {sharesQuery.isLoading ? (
            <>
              <div className={styles.skeleton} />
              <div className={styles.skeleton} />
            </>
          ) : sharesQuery.isError ? (
            <p className={styles.error} role="alert">
              {sharesQuery.error?.message || 'Could not load shares'}
            </p>
          ) : shares.length === 0 ? (
            <p className={styles.empty}>Not shared with anyone yet</p>
          ) : (
            <ul className={styles.grantList}>
              {shares.map((share) => {
                const name = share.granteeName ?? share.granteeId;
                return (
                  <li key={share.id} className={styles.grantRow} data-testid="share-grant-row">
                    <span className={styles.grantName}>{name}</span>
                    <span className={styles.grantBadge}>View only</span>
                    <button
                      type="button"
                      className={styles.btnDanger}
                      onClick={() => handleRevoke(share)}
                      disabled={busy}
                      aria-label={`Revoke access for ${name}`}
                      data-testid="share-revoke-button"
                    >
                      Revoke
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className={styles.actions}>
          <button
            ref={closeRef}
            type="button"
            className={styles.btnSecondary}
            onClick={onClose}
            disabled={busy}
            data-testid="share-dialog-close"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default ShareUiLabDialog;
