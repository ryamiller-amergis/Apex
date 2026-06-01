import React, { useState, useEffect, useCallback } from 'react';
import { useAvailableApprovers } from '../hooks/useInterviews';
import styles from './ApproverSelectModal.module.css';

interface ApproverSelectModalProps {
  documentType: 'prd' | 'design_doc';
  project: string;
  onConfirm: (selections: { prdApproverIds?: string[]; designDocApproverIds?: string[]; approverIds?: string[] }) => void;
  onCancel: () => void;
  isSubmitting?: boolean;
  initialPrdApproverIds?: string[];
  initialDesignDocApproverIds?: string[];
  initialApproverIds?: string[];
  confirmLabel?: string;
  excludeSelf?: boolean;
  allowEmpty?: boolean;
}

export const ApproverSelectModal: React.FC<ApproverSelectModalProps> = ({
  documentType,
  project,
  onConfirm,
  onCancel,
  isSubmitting = false,
  initialPrdApproverIds,
  initialDesignDocApproverIds,
  initialApproverIds,
  confirmLabel,
  excludeSelf = true,
  allowEmpty = false,
}) => {
  const { data: prdApprovers, isLoading: prdLoading } = useAvailableApprovers(project, 'prd', excludeSelf);
  const { data: ddApprovers, isLoading: ddLoading } = useAvailableApprovers(project, 'design_doc', excludeSelf);

  const [selectedPrdApprovers, setSelectedPrdApprovers] = useState<Set<string>>(
    () => new Set(initialPrdApproverIds ?? []),
  );
  const [selectedDdApprovers, setSelectedDdApprovers] = useState<Set<string>>(
    () => new Set(initialDesignDocApproverIds ?? initialApproverIds ?? []),
  );

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onCancel]);

  const togglePrd = useCallback((id: string) => {
    setSelectedPrdApprovers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleDd = useCallback((id: string) => {
    setSelectedDdApprovers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleConfirm = useCallback(() => {
    if (documentType === 'prd') {
      onConfirm({
        prdApproverIds: [...selectedPrdApprovers],
        designDocApproverIds: [...selectedDdApprovers],
      });
    } else {
      onConfirm({
        approverIds: [...selectedDdApprovers],
      });
    }
  }, [documentType, selectedPrdApprovers, selectedDdApprovers, onConfirm]);

  const isPrdSection = documentType === 'prd';

  const canConfirm =
    (allowEmpty ||
      (isPrdSection
        ? selectedPrdApprovers.size > 0 && selectedDdApprovers.size > 0
        : selectedDdApprovers.size > 0)) && !isSubmitting;

  const renderChips = (
    approvers: { userId: string; displayName: string }[] | undefined,
    isLoading: boolean,
    selected: Set<string>,
    onToggle: (id: string) => void,
  ) => {
    if (isLoading) return <span className={styles.loadingText}>Loading approvers…</span>;
    if (!approvers || approvers.length === 0) {
      return <span className={styles.emptyText}>No approvers configured for this project</span>;
    }
    return (
      <div className={styles.chipGrid}>
        {approvers.map((a) => {
          const isSelected = selected.has(a.userId);
          return (
            <button
              key={a.userId}
              type="button"
              className={`${styles.chip} ${isSelected ? styles.chipSelected : ''}`}
              onClick={() => onToggle(a.userId)}
              disabled={isSubmitting}
            >
              {isSelected && (
                <svg className={styles.chipCheck} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="2 7 5.5 10.5 12 4" />
                </svg>
              )}
              {a.displayName}
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <div
      className={styles.overlay}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="approver-select-title"
    >
      <div className={styles.card}>
        <div>
          <h2 className={styles.title} id="approver-select-title">Select Approvers</h2>
          <p className={styles.subtitle}>
            {allowEmpty
              ? 'Select approvers or deselect all to remove pending approvers.'
              : `Choose who should review this document. At least one approver is required${isPrdSection ? ' in each section' : ''}.`}
          </p>
        </div>

        {isPrdSection && (
          <div className={styles.section}>
            <h3 className={styles.sectionTitle}>PRD Approvers</h3>
            {renderChips(prdApprovers, prdLoading, selectedPrdApprovers, togglePrd)}
          </div>
        )}

        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>Design Doc Approvers</h3>
          {renderChips(ddApprovers, ddLoading, selectedDdApprovers, toggleDd)}
        </div>

        {!canConfirm && !isSubmitting && (
          <p className={styles.validationHint}>
            {isPrdSection
              ? 'Select at least one PRD approver and one Design Doc approver'
              : 'Select at least one approver'}
          </p>
        )}

        <div className={styles.actions}>
          <button
            className={styles.btnCancel}
            onClick={onCancel}
            disabled={isSubmitting}
            type="button"
          >
            Cancel
          </button>
          <button
            className={styles.btnConfirm}
            onClick={handleConfirm}
            disabled={!canConfirm}
            type="button"
          >
            {isSubmitting ? 'Submitting…' : (confirmLabel ?? 'Submit for Review')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ApproverSelectModal;
