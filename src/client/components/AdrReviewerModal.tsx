import React, { useEffect, useMemo, useState } from 'react';
import { useAdrReviewerCandidates } from '../hooks/useAdrs';
import styles from './SectionOwnerModal.module.css';

interface AdrReviewerModalProps {
  project: string;
  ownerName: string;
  initialReviewerIds?: string[];
  mode?: 'create' | 'edit';
  onConfirm: (reviewerIds: string[]) => void;
  onCancel: () => void;
  isSubmitting?: boolean;
}

export const AdrReviewerModal: React.FC<AdrReviewerModalProps> = ({
  project,
  ownerName,
  initialReviewerIds = [],
  mode = 'create',
  onConfirm,
  onCancel,
  isSubmitting = false,
}) => {
  const { data: candidates = [], isLoading, error } = useAdrReviewerCandidates(project);
  const [selectedIds, setSelectedIds] = useState<string[]>(initialReviewerIds);
  const allSelected = candidates.length > 0 && candidates.every((candidate) => selectedIds.includes(candidate.id));
  const selectedNames = useMemo(
    () => candidates.filter((candidate) => selectedIds.includes(candidate.id)),
    [candidates, selectedIds],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  useEffect(() => {
    if (isLoading || candidates.length === 0) return;
    const candidateIds = new Set(candidates.map((candidate) => candidate.id));
    setSelectedIds((current) => {
      const validIds = current.filter((id) => candidateIds.has(id));
      return validIds.length === current.length ? current : validIds;
    });
  }, [candidates, isLoading]);

  const toggleReviewer = (id: string) => {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((candidateId) => candidateId !== id) : [...current, id],
    );
  };

  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="adr-reviewer-title"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className={styles.card}>
        <div className={styles.header}>
          <div className={styles.headerText}>
            <h2 className={styles.title} id="adr-reviewer-title">
              {mode === 'edit' ? 'Manage ADR Reviewers' : 'Assign ADR Owner & Reviewers'}
            </h2>
            <p className={styles.subtitle}>
              {mode === 'edit'
                ? 'Add or remove reviewers from the project’s Developer group.'
                : 'You will own this ADR. Select reviewers from the project’s Developer group.'}
            </p>
          </div>
          <button className={styles.closeBtn} type="button" onClick={onCancel} aria-label="Close">✕</button>
        </div>

        <div className={styles.fields}>
          <div className={styles.field}>
            <span className={styles.label}>Owner</span>
            <div className={styles.selectedChip}>
              <span className={styles.selectedAvatar}>{ownerName.slice(0, 1).toUpperCase()}</span>
              <span className={styles.selectedInfo}>
                <span className={styles.selectedName}>{ownerName}</span>
                <span className={styles.selectedEmail}>Signed-in user</span>
              </span>
            </div>
          </div>

          <div className={styles.field}>
            <div className={styles.groupHeader}>
              <span className={styles.label}>Developer Reviewers</span>
              {candidates.length > 0 && (
                <button
                  className={styles.selectAllBtn}
                  type="button"
                  onClick={() => setSelectedIds(allSelected ? [] : candidates.map((candidate) => candidate.id))}
                  disabled={isSubmitting}
                >
                  {allSelected ? 'Deselect all' : 'Select all'}
                </button>
              )}
            </div>
            {isLoading ? (
              <span className={styles.loadingText}>Loading Developer group…</span>
            ) : error ? (
              <span className={styles.noApprovers}>{error.message}</span>
            ) : candidates.length === 0 ? (
              <span className={styles.noApprovers}>No members are assigned to the Developer group.</span>
            ) : (
              <div className={styles.chipGrid}>
                {candidates.map((candidate) => {
                  const selected = selectedIds.includes(candidate.id);
                  return (
                    <button
                      key={candidate.id}
                      type="button"
                      className={`${styles.chip} ${selected ? styles.chipSelected : ''}`}
                      onClick={() => toggleReviewer(candidate.id)}
                      disabled={isSubmitting}
                      aria-pressed={selected}
                    >
                      {selected && (
                        <svg className={styles.chipCheck} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                          <path d="M6.5 12.5l-4-4 1.4-1.4 2.6 2.6 5.6-5.6 1.4 1.4z" />
                        </svg>
                      )}
                      {candidate.displayName}
                    </button>
                  );
                })}
              </div>
            )}
            {selectedNames.length > 0 && (
              <p className={styles.validationHint}>{selectedNames.length} reviewer{selectedNames.length === 1 ? '' : 's'} selected</p>
            )}
          </div>
        </div>

        <div className={styles.navRow}>
          <button className={styles.btnSkip} type="button" onClick={onCancel} disabled={isSubmitting}>Cancel</button>
          <button
            className={styles.btnConfirm}
            type="button"
            onClick={() => onConfirm(selectedIds)}
            disabled={isSubmitting || isLoading || mode === 'create' && candidates.length > 0 && selectedIds.length === 0}
          >
            {isSubmitting
              ? (mode === 'edit' ? 'Saving…' : 'Creating…')
              : (mode === 'edit' ? 'Save Reviewers' : 'Confirm & Start ADR')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AdrReviewerModal;
