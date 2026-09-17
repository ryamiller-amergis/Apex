import React, { useEffect, useState } from 'react';
import type {
  ActiveUser,
  InterviewPhaseStatus,
  PhaseOwnerRole,
} from '../../shared/types/interview';
import styles from './PhaseOwnerChip.module.css';

interface PhaseOwnerChipProps {
  phase: PhaseOwnerRole;
  ownerId: string;
  ownerName: string;
  status?: InterviewPhaseStatus | null;
  canChange: boolean;
  users: ActiveUser[];
  usersLoading?: boolean;
  onSave: (ownerId: string) => Promise<unknown>;
  'data-testid'?: string;
}

export const PhaseOwnerChip: React.FC<PhaseOwnerChipProps> = ({
  phase,
  ownerId,
  ownerName,
  status,
  canChange,
  users,
  usersLoading = false,
  onSave,
  'data-testid': dataTestId,
}) => {
  const label = phase === 'requirements' ? 'Requirements' : 'Technical';
  const approved = status === 'approved';
  const [editing, setEditing] = useState(false);
  const [selectedOwnerId, setSelectedOwnerId] = useState(ownerId);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setSelectedOwnerId(ownerId);
  }, [ownerId]);

  const cancel = () => {
    setSelectedOwnerId(ownerId);
    setError(null);
    setEditing(false);
  };

  const save = async () => {
    if (!selectedOwnerId || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(selectedOwnerId);
      setEditing(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to change phase owner');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className={styles.wrapper}
      {...{ 'data-testid': dataTestId ?? `interview-owner-chip-${phase}` }}
    >
      <div className={styles.summary}>
        <span className={styles.ownerText}>{label}: {ownerName}</span>
        {approved && (
          <span
            className={styles.approved}
            aria-label={`${label} phase approved and locked`}
            title="Approved"
          >
            <span aria-hidden="true">🔒</span>
            Approved
          </span>
        )}
        {canChange && !approved && !editing && (
          <button
            className={styles.changeButton}
            type="button"
            aria-label={`Change ${label} owner`}
            onClick={() => setEditing(true)}
            {...{ 'data-testid': `phase-owner-change-btn-${phase}` }}
          >
            Change owner
          </button>
        )}
      </div>

      {editing && !approved && (
        <div className={styles.editor}>
          <label className={styles.label} htmlFor={`phase-owner-${phase}`}>
            {label} owner
          </label>
          <select
            id={`phase-owner-${phase}`}
            className={styles.select}
            value={selectedOwnerId}
            disabled={usersLoading || saving}
            onChange={(event) => setSelectedOwnerId(event.target.value)}
            {...{ 'data-testid': `phase-owner-reassign-select-${phase}` }}
          >
            {usersLoading && <option value="">Loading users…</option>}
            {!usersLoading && users.map((user) => (
              <option key={user.oid} value={user.oid}>
                {user.displayName}{user.email ? ` (${user.email})` : ''}
              </option>
            ))}
          </select>
          <div className={styles.actions}>
            <button
              className={styles.saveButton}
              type="button"
              disabled={!selectedOwnerId || selectedOwnerId === ownerId || saving}
              aria-label={`Save ${label} owner`}
              onClick={() => void save()}
              {...{ 'data-testid': `phase-owner-save-btn-${phase}` }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              className={styles.cancelButton}
              type="button"
              disabled={saving}
              aria-label={`Cancel ${label} owner change`}
              onClick={cancel}
              {...{ 'data-testid': `phase-owner-cancel-btn-${phase}` }}
            >
              Cancel
            </button>
          </div>
          {error && <div className={styles.error} role="alert">{error}</div>}
        </div>
      )}
    </div>
  );
};
