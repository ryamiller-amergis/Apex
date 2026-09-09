import React, { useEffect, useId, useRef, useState } from 'react';
import type {
  DiagramShare,
  DiagramShareAccess,
  DiagramShareTarget,
} from '../../shared/types/diagram';
import { DIAGRAM_SHARE_ACCESS_VALUES } from '../../shared/types/diagram';
import {
  useChangeShareAccess,
  useCreateShare,
  useDiagramShares,
  useRevokeShare,
  useShareTargets,
} from '../hooks/useDiagramShares';
import dialogShell from './DiagramDialog.module.css';
import styles from './ShareDiagramDialog.module.css';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface ShareAccessSelectorProps {
  value: DiagramShareAccess;
  onChange: (access: DiagramShareAccess) => void;
  disabled?: boolean;
  idPrefix?: string;
  'data-testid'?: string;
}

export const ShareAccessSelector: React.FC<ShareAccessSelectorProps> = ({
  value,
  onChange,
  disabled = false,
  idPrefix = 'share-access',
  'data-testid': testId = 'share-access-selector',
}) => (
  <div
    className={styles.accessRow}
    role="group"
    aria-label="Share access level"
    {...{ 'data-testid': testId }}
  >
    {DIAGRAM_SHARE_ACCESS_VALUES.map((access) => (
      <button
        key={access}
        type="button"
        className={`${styles.accessOption} ${value === access ? styles.accessOptionActive : ''}`}
        aria-pressed={value === access}
        disabled={disabled}
        onClick={() => onChange(access)}
        {...{ 'data-testid': `${idPrefix}-${access}` }}
      >
        {access === 'view' ? 'View only' : 'Can edit'}
      </button>
    ))}
  </div>
);

interface ShareTargetPickerProps {
  targets: DiagramShareTarget[];
  isLoading: boolean;
  query: string;
  selectedUserId: string | null;
  onQueryChange: (query: string) => void;
  onSelect: (target: DiagramShareTarget) => void;
}

export const ShareTargetPicker: React.FC<ShareTargetPickerProps> = ({
  targets,
  isLoading,
  query,
  selectedUserId,
  onQueryChange,
  onSelect,
}) => (
  <div {...{ 'data-testid': 'share-target-picker' }}>
    <label className={styles.fieldLabel}>
      Project member
      <input
        className={styles.input}
        type="search"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Search teammates"
        aria-label="Search project members"
        {...{ 'data-testid': 'share-target-search' }}
      />
    </label>
    {isLoading ? (
      <div className={styles.skeleton} aria-busy="true" aria-label="Loading members" />
    ) : targets.length === 0 ? (
      <p className={styles.empty}>No other project members to share with</p>
    ) : (
      <ul
        className={styles.targetList}
        role="listbox"
        aria-label="Eligible share targets"
        {...{ 'data-testid': 'share-target-list' }}
      >
        {targets.map((target) => {
          const label = target.displayName ?? target.email ?? target.userId;
          const selected = selectedUserId === target.userId;
          return (
            <li key={target.userId}>
              <button
                type="button"
                role="option"
                aria-selected={selected}
                className={`${styles.targetOption} ${selected ? styles.targetOptionSelected : ''}`}
                onClick={() => onSelect(target)}
                {...{ 'data-testid': `share-target-${target.userId}` }}
              >
                <span>{label}</span>
                <span className={styles.targetMeta}>
                  {target.existingAccess
                    ? `Has ${target.existingAccess}`
                    : 'Not shared'}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    )}
  </div>
);

interface ShareGrantRowProps {
  share: DiagramShare;
  busy: boolean;
  onChangeAccess: (access: DiagramShareAccess) => void;
  onRevoke: () => void;
}

export const ShareGrantRow: React.FC<ShareGrantRowProps> = ({
  share,
  busy,
  onChangeAccess,
  onRevoke,
}) => {
  const name = share.granteeName ?? share.granteeId;
  return (
    <li
      className={styles.grantRow}
      {...{ 'data-testid': 'share-grant-row' }}
    >
      <span className={styles.grantName}>{name}</span>
      <span
        className={styles.grantBadge}
        aria-label={`Access: ${share.access === 'edit' ? 'can edit' : 'view only'}`}
      >
        {share.access === 'edit' ? 'Can edit' : 'View only'}
      </span>
      <ShareAccessSelector
        value={share.access}
        onChange={onChangeAccess}
        disabled={busy}
        idPrefix={`share-grant-${share.granteeId}-access`}
        {...{ 'data-testid': `share-grant-access-${share.granteeId}` }}
      />
      <button
        type="button"
        className={styles.btnDanger}
        onClick={onRevoke}
        disabled={busy}
        aria-label={`Revoke access for ${name}`}
        {...{ 'data-testid': 'share-revoke-button' }}
      >
        Revoke
      </button>
    </li>
  );
};

interface ShareDiagramDialogProps {
  projectId: string;
  diagramId: string;
  diagramTitle: string;
  onClose: () => void;
  'data-testid'?: string;
}

export const ShareDiagramDialog: React.FC<ShareDiagramDialogProps> = ({
  projectId,
  diagramId,
  diagramTitle,
  onClose,
  'data-testid': testId = 'share-diagram-dialog',
}) => {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const [query, setQuery] = useState('');
  const [selectedTarget, setSelectedTarget] = useState<DiagramShareTarget | null>(null);
  const [access, setAccess] = useState<DiagramShareAccess>('view');
  const [error, setError] = useState<string | null>(null);

  const sharesQuery = useDiagramShares(projectId, diagramId, true);
  const targetsQuery = useShareTargets(projectId, diagramId, query, true);
  const createMutation = useCreateShare(projectId, diagramId);
  const changeMutation = useChangeShareAccess(projectId, diagramId);
  const revokeMutation = useRevokeShare(projectId, diagramId);

  const busy = createMutation.isPending
    || changeMutation.isPending
    || revokeMutation.isPending;

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

  const handleSelectTarget = (target: DiagramShareTarget) => {
    setSelectedTarget(target);
    setError(null);
    if (target.existingAccess) {
      setAccess(target.existingAccess);
    }
  };

  const handleAddOrChange = () => {
    if (!selectedTarget) {
      setError('Select a project member to share with');
      return;
    }
    setError(null);

    if (selectedTarget.existingAccess) {
      changeMutation.mutate(
        { granteeId: selectedTarget.userId, access },
        {
          onError: (err) => {
            setError(err.message || 'Failed to update share');
          },
          onSuccess: () => {
            setSelectedTarget(null);
            setAccess('view');
          },
        },
      );
      return;
    }

    createMutation.mutate(
      { granteeId: selectedTarget.userId, access },
      {
        onError: (err) => {
          setError(err.message || 'Failed to add share');
        },
        onSuccess: () => {
          setSelectedTarget(null);
          setAccess('view');
        },
      },
    );
  };

  const handleChangeExisting = (share: DiagramShare, next: DiagramShareAccess) => {
    setError(null);
    changeMutation.mutate(
      { granteeId: share.granteeId, access: next },
      {
        onError: (err) => {
          setError(err.message || 'Failed to update share');
        },
      },
    );
  };

  const handleRevoke = (share: DiagramShare) => {
    setError(null);
    revokeMutation.mutate(share.granteeId, {
      onError: (err) => {
        setError(err.message || 'Failed to revoke share');
      },
    });
  };

  const shares = sharesQuery.data ?? [];
  const addLabel = selectedTarget?.existingAccess
    ? 'Update access'
    : 'Add share';

  return (
    <div
      className={dialogShell.overlay}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      {...{ 'data-testid': testId }}
    >
      <div className={styles.dialog} ref={dialogRef}>
        <h2 className={styles.title} id={titleId}>
          Share &ldquo;{diagramTitle}&rdquo;
        </h2>
        <p className={styles.subtitle}>
          Grant view or edit access to current project members. Only you can manage shares.
        </p>

        {error && (
          <p
            className={styles.error}
            role="alert"
            aria-live="assertive"
            {...{ 'data-testid': 'share-error' }}
          >
            {error}
          </p>
        )}

        <div className={styles.addForm} {...{ 'data-testid': 'share-add-form' }}>
          <ShareTargetPicker
            targets={targetsQuery.data ?? []}
            isLoading={targetsQuery.isLoading}
            query={query}
            selectedUserId={selectedTarget?.userId ?? null}
            onQueryChange={setQuery}
            onSelect={handleSelectTarget}
          />
          <ShareAccessSelector
            value={access}
            onChange={setAccess}
            disabled={busy}
            {...{ 'data-testid': 'share-access-selector' }}
          />
          <button
            type="button"
            className={styles.btnPrimary}
            onClick={handleAddOrChange}
            disabled={busy || !selectedTarget}
            {...{ 'data-testid': 'share-add-button' }}
          >
            {busy && (createMutation.isPending || changeMutation.isPending)
              ? 'Saving…'
              : addLabel}
          </button>
        </div>

        <div {...{ 'data-testid': 'share-grant-section' }}>
          <h3 className={styles.subtitle}>People with access</h3>
          {sharesQuery.isLoading ? (
            <>
              <div className={styles.skeleton} />
              <div className={styles.skeleton} />
            </>
          ) : sharesQuery.isError ? (
            <p className={styles.error} role="alert" {...{ 'data-testid': 'share-error' }}>
              {sharesQuery.error?.message || 'Could not load shares'}
            </p>
          ) : shares.length === 0 ? (
            <p className={styles.empty}>Not shared with anyone yet</p>
          ) : (
            <ul className={styles.grantList}>
              {shares.map((share) => (
                <ShareGrantRow
                  key={share.id}
                  share={share}
                  busy={busy}
                  onChangeAccess={(next) => handleChangeExisting(share, next)}
                  onRevoke={() => handleRevoke(share)}
                />
              ))}
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
            {...{ 'data-testid': 'share-dialog-close' }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default ShareDiagramDialog;
