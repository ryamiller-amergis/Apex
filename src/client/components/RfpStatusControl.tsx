import React, { useState } from 'react';
import { canReopenRfp, canTransitionRfpStatus, RFP_STATUS_TRANSITIONS } from '../../shared/types/rfpIntake';
import type { RfpHumanStatus, RfpTriageDetail } from '../../shared/types/rfpIntake';
import { useRfpReopen, useRfpStatusTransition } from '../hooks/useRfpTriage';
import styles from './RfpQueueView.module.css';

interface RfpStatusControlProps {
  detail: RfpTriageDetail;
  canManage: boolean;
}

function formatLabel(value: string): string {
  return value.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

export const RfpStatusControl: React.FC<RfpStatusControlProps> = ({ detail, canManage }) => {
  const transition = useRfpStatusTransition();
  const reopen = useRfpReopen();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reason, setReason] = useState('');
  const targets = RFP_STATUS_TRANSITIONS[detail.status];

  if (!canManage) return null;

  return (
    <section className={styles.block} {...{ 'data-testid': 'rfp-status-control' }}>
      <h3 className={styles.blockTitle}>Review decision</h3>
      <p className={styles.subtitle} aria-live="polite">
        Current status: {formatLabel(detail.status)}
      </p>
      {(transition.isError || reopen.isError) && (
        <p className={`${styles.banner} ${styles.errorBanner}`} role="alert">
          {transition.error?.message ?? reopen.error?.message ?? 'The previous status was kept.'}
        </p>
      )}
      <div className={styles.actions}>
        {targets.filter((target) => canTransitionRfpStatus(detail.status, target)).map((target) => (
          <button
            key={target}
            type="button"
            className={styles.secondaryButton}
            disabled={transition.isPending}
            onClick={() => void transition.mutateAsync({ id: detail.id, target: target as RfpHumanStatus })}
            {...{ 'data-testid': `rfp-status-${target}` }}
          >
            {formatLabel(target)}
          </button>
        ))}
        {canReopenRfp(detail.status) && (
          <button
            type="button"
            className={styles.primaryButton}
            onClick={() => setConfirmOpen(true)}
            {...{ 'data-testid': 'rfp-reopen-button' }}
          >
            Reopen
          </button>
        )}
      </div>

      {confirmOpen && (
        <div
          className={styles.confirm}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="rfp-reopen-title"
          {...{ 'data-testid': 'rfp-reopen-confirm' }}
        >
          <div className={styles.confirmCard}>
            <h3 id="rfp-reopen-title">Reopen this request?</h3>
            <p className={styles.subtitle}>This audited action returns the request to In Review.</p>
            <label className={styles.subtitle} htmlFor="rfp-reopen-reason">Reason</label>
            <textarea
              id="rfp-reopen-reason"
              className={styles.textarea}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              {...{ 'data-testid': 'rfp-reopen-reason' }}
            />
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => setConfirmOpen(false)}
                {...{ 'data-testid': 'rfp-reopen-cancel' }}
              >
                Cancel
              </button>
              <button
                type="button"
                className={styles.primaryButton}
                disabled={!reason.trim() || reopen.isPending}
                onClick={() => {
                  void reopen.mutateAsync({ id: detail.id, reason: reason.trim() }).then(() => {
                    setConfirmOpen(false);
                    setReason('');
                  });
                }}
                {...{ 'data-testid': 'rfp-reopen-confirm-submit' }}
              >
                Confirm reopen
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};

export { formatLabel };
