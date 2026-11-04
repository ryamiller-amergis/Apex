import React, { useState, useRef, useCallback } from 'react';
import type { BuildRunStatus } from '../../shared/types/build';
import { AcceptBuildModal } from './AcceptBuildModal';
import styles from './BuildAccept.module.css';

export interface BuildAcceptActionProps {
  buildStatus: BuildRunStatus;
  canAccept: boolean;
  revisionNumber: number;
  riskDecisionCount: number;
  onAccept: (revisionNumber: number) => Promise<unknown>;
  onReload?: () => void;
}

export const BuildAcceptAction: React.FC<BuildAcceptActionProps> = ({
  buildStatus,
  canAccept,
  revisionNumber,
  riskDecisionCount,
  onAccept,
  onReload,
}) => {
  const [modalOpen, setModalOpen] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isStaleRevision, setIsStaleRevision] = useState(false);
  const inFlightRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const handleClose = useCallback(() => {
    setModalOpen(false);
    setErrorMessage(null);
    setIsStaleRevision(false);
    triggerRef.current?.focus();
  }, []);

  const handleConfirm = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setIsPending(true);
    setErrorMessage(null);
    setIsStaleRevision(false);
    try {
      await onAccept(revisionNumber);
      setModalOpen(false);
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      setIsStaleRevision(code === 'BUILD_STALE_REVISION');
      setErrorMessage(
        err instanceof Error && err.message
          ? err.message
          : 'Could not accept this preview. Try again.',
      );
    } finally {
      inFlightRef.current = false;
      setIsPending(false);
    }
  }, [onAccept, revisionNumber]);

  if (buildStatus !== 'preview_ready' || !canAccept) {
    return null;
  }

  return (
    <div className={styles.actionWrapper}>
      <button
        ref={triggerRef}
        type="button"
        disabled={isPending}
        className={styles.acceptButton}
        onClick={() => setModalOpen(true)}
        {...{ 'data-testid': 'build-accept-btn' }}
      >
        {isPending ? 'Accepting…' : 'Accept and open pull request'}
      </button>

      {/* data-testid-exempt */}
      <AcceptBuildModal
        open={modalOpen}
        revisionNumber={revisionNumber}
        riskDecisionCount={riskDecisionCount}
        isPending={isPending}
        errorMessage={errorMessage}
        isStaleRevision={isStaleRevision}
        onConfirm={() => {
          void handleConfirm();
        }}
        onCancel={handleClose}
        onReload={onReload}
      />
    </div>
  );
};
