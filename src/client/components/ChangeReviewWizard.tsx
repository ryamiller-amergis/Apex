import React, { useState, useEffect } from 'react';
import { DiffView } from './DiffView';
import type { ChangeUnit, ChangeDecision } from '../utils/changeReview';
import { allUnitsDecided, countDecisions } from '../utils/changeReview';
import styles from './ChangeReviewWizard.module.css';

export interface ChangeReviewWizardProps {
  units: ChangeUnit[];
  onDecision: (unitId: string, decision: Exclude<ChangeDecision, 'pending'>) => void;
  onRequestRegenerate: (unitId: string, feedback: string) => void | Promise<void>;
  onFinish: (units: ChangeUnit[]) => void | Promise<void>;
  onCancel?: () => void;
  cancelLabel?: string;
  isRegenerating?: boolean;
  isApplying?: boolean;
}

type WizardPhase = 'review' | 'summary';

export const ChangeReviewWizard: React.FC<ChangeReviewWizardProps> = ({
  units,
  onDecision,
  onRequestRegenerate,
  onFinish,
  onCancel,
  cancelLabel = 'Cancel',
  isRegenerating = false,
  isApplying = false,
}) => {
  const [stepIndex, setStepIndex] = useState(0);
  const [phase, setPhase] = useState<WizardPhase>('review');
  const [feedback, setFeedback] = useState('');
  const [showFeedback, setShowFeedback] = useState(false);

  const total = units.length;
  const safeIndex = total === 0 ? 0 : Math.min(stepIndex, total - 1);
  const unit = total > 0 ? units[safeIndex] : null;
  const counts = countDecisions(units);
  const decided = allUnitsDecided(units);
  const busy = isRegenerating || isApplying;

  useEffect(() => {
    setFeedback('');
    setShowFeedback(false);
  }, [safeIndex, unit?.id]);

  // Keep step in range when units shrink after regenerate
  useEffect(() => {
    if (total === 0) return;
    if (stepIndex > total - 1) setStepIndex(total - 1);
  }, [total, stepIndex]);

  if (total === 0) {
    return (
      <div className={styles.wizard} role="region" aria-label="Change review wizard">
        <div className={styles.empty}>No reviewable changes were found.</div>
        {onCancel && (
          <div className={styles.footer}>
            <button type="button" className={styles.secondaryBtn} onClick={onCancel}>
              {cancelLabel}
            </button>
          </div>
        )}
      </div>
    );
  }

  const goNext = () => {
    if (safeIndex < total - 1) {
      setStepIndex(safeIndex + 1);
      return;
    }
    setPhase('summary');
  };

  const goBack = () => {
    if (phase === 'summary') {
      setPhase('review');
      setStepIndex(total - 1);
      return;
    }
    if (safeIndex > 0) setStepIndex(safeIndex - 1);
  };

  const handleApprove = () => {
    if (!unit || busy) return;
    onDecision(unit.id, 'approved');
    goNext();
  };

  const handleReject = () => {
    if (!unit || busy) return;
    onDecision(unit.id, 'rejected');
    goNext();
  };

  const handleRegenerate = async () => {
    if (!unit || busy || !feedback.trim()) return;
    await onRequestRegenerate(unit.id, feedback.trim());
    setFeedback('');
    setShowFeedback(false);
  };

  const handleFinish = async () => {
    if (busy) return;
    await onFinish(units);
  };

  return (
    <div className={styles.wizard} role="region" aria-label="Change review wizard">
      <div className={styles.header}>
        <div className={styles.progress}>
          {phase === 'review' ? (
            <span>
              Change {safeIndex + 1} of {total}
            </span>
          ) : (
            <span>Review summary</span>
          )}
          <span className={styles.progressCounts}>
            {counts.approved} approved · {counts.rejected} rejected
            {counts.pending > 0 ? ` · ${counts.pending} pending` : ''}
          </span>
        </div>
        <div className={styles.progressBar} aria-hidden="true">
          <div
            className={styles.progressFill}
            style={{
              width: `${phase === 'summary' ? 100 : ((safeIndex + 1) / total) * 100}%`,
            }}
          />
        </div>
      </div>

      {phase === 'review' && unit && (
        <>
          <div className={styles.unitTitle}>
            <span>{unit.title}</span>
            {unit.decision !== 'pending' && (
              <span
                className={
                  unit.decision === 'approved' ? styles.badgeApproved : styles.badgeRejected
                }
              >
                {unit.decision === 'approved' ? 'Approved' : 'Rejected'}
              </span>
            )}
          </div>

          <div className={styles.diffWrap}>
            <DiffView oldText={unit.oldText} newText={unit.newText} />
          </div>

          {showFeedback ? (
            <div className={styles.feedbackPanel}>
              <label className={styles.feedbackLabel} htmlFor={`change-feedback-${unit.id}`}>
                Tell the AI what you want instead
              </label>
              <textarea
                id={`change-feedback-${unit.id}`}
                className={styles.feedbackInput}
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                rows={3}
                placeholder="e.g. Keep the route as /1-on-1 and use nav label “1:1”…"
                disabled={busy}
              />
              <div className={styles.feedbackActions}>
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  onClick={() => {
                    setShowFeedback(false);
                    setFeedback('');
                  }}
                  disabled={busy}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className={styles.primaryBtn}
                  onClick={() => void handleRegenerate()}
                  disabled={busy || !feedback.trim()}
                >
                  {isRegenerating ? 'Regenerating…' : 'Regenerate this change'}
                </button>
              </div>
            </div>
          ) : (
            <div className={styles.decisionBar}>
              <button
                type="button"
                className={styles.approveBtn}
                onClick={handleApprove}
                disabled={busy}
              >
                Approve
              </button>
              <button
                type="button"
                className={styles.rejectBtn}
                onClick={handleReject}
                disabled={busy}
              >
                Reject
              </button>
              <button
                type="button"
                className={styles.askAiBtn}
                onClick={() => setShowFeedback(true)}
                disabled={busy}
              >
                Ask AI to change
              </button>
            </div>
          )}
        </>
      )}

      {phase === 'summary' && (
        <div className={styles.summary}>
          <p className={styles.summaryLead}>
            {decided
              ? 'All changes have a decision. Finish to apply approved changes to the live PRD.'
              : 'Some changes are still pending. Go back to decide, or Finish will keep pending changes as rejected (live text unchanged).'}
          </p>
          <ul className={styles.summaryList}>
            {units.map((u, i) => (
              <li key={u.id} className={styles.summaryItem}>
                <button
                  type="button"
                  className={styles.summaryLink}
                  onClick={() => {
                    setPhase('review');
                    setStepIndex(i);
                  }}
                >
                  {u.title}
                </button>
                <span
                  className={
                    u.decision === 'approved'
                      ? styles.badgeApproved
                      : u.decision === 'rejected'
                        ? styles.badgeRejected
                        : styles.badgePending
                  }
                >
                  {u.decision}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className={styles.footer}>
        <div className={styles.footerLeft}>
          {onCancel && (
            <button type="button" className={styles.secondaryBtn} onClick={onCancel} disabled={busy}>
              {cancelLabel}
            </button>
          )}
        </div>
        <div className={styles.footerRight}>
          <button
            type="button"
            className={styles.secondaryBtn}
            onClick={goBack}
            disabled={busy || (phase === 'review' && safeIndex === 0)}
          >
            Back
          </button>
          {phase === 'review' ? (
            <button
              type="button"
              className={styles.secondaryBtn}
              onClick={goNext}
              disabled={busy}
            >
              {safeIndex < total - 1 ? 'Skip / Next' : 'Summary'}
            </button>
          ) : (
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={() => void handleFinish()}
              disabled={busy}
            >
              {isApplying ? 'Applying…' : 'Finish'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default ChangeReviewWizard;
